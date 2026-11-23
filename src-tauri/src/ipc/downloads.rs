//! IPC commands: Offline downloads (S5-003; owner `downloads` in docs/ipc-commands.md)
#![allow(unused_imports)]

use crate::*;

#[tauri::command]
pub fn download_info(
    song_id: LibraryId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Option<DownloadInfo>> {
    let song_id = song_id.into_inner();
    let id = song_id.trim();
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let Some(info) = read_download_info(&db, id)? else {
        return Ok(None);
    };
    if info.state == "downloading" && !download_is_active(id) {
        let partial_path = format!("{}.part", info.path);
        let retained_bytes = fs::metadata(&partial_path)
            .map(|metadata| metadata.len() as i64)
            .unwrap_or(info.bytes);
        db.execute(
            "UPDATE downloads SET bytes = ?1, state = 'cancelled', error = ?2 WHERE song_id = ?3",
            params![retained_bytes, "download interrupted; retry to resume", id],
        )
        .map_err(|error| format!("download recovery state failed: {error}"))?;
        return Ok(read_download_info(&db, id)?);
    }
    Ok(Some(info))
}

#[tauri::command]
pub fn download_cancel(song_id: LibraryId) -> IpcResult<()> {
    let song_id = song_id.into_inner();
    let id = song_id.trim();
    if id.is_empty() {
        return Err(IpcError::from("download song id is empty".to_owned()));
    }
    let map = download_cancel_map()
        .lock()
        .map_err(|_| "download cancellation state poisoned".to_owned())?;
    if let Some(flag) = map.get(id) {
        flag.store(true, Ordering::Release);
        Ok(())
    } else {
        Err(IpcError::from(
            "download is not currently active".to_owned(),
        ))
    }
}

#[tauri::command]
pub fn download_remove(song_id: LibraryId, state: tauri::State<'_, RuntimeState>) -> IpcResult<()> {
    let song_id = song_id.into_inner();
    let id = song_id.trim();
    if id.is_empty() {
        return Err(IpcError::from("download song id is empty".to_owned()));
    }
    if download_cancel_map()
        .lock()
        .map_err(|_| "download cancellation state poisoned".to_owned())?
        .contains_key(id)
    {
        return Err(IpcError::from(
            "cancel the active download before removing its cache".to_owned(),
        ));
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    if let Some(info) = read_download_info(&db, id)? {
        let path = info.path;
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{}.part", path));
        if let Some(artwork_path) = info.artwork_path {
            let _ = fs::remove_file(&artwork_path);
            let _ = fs::remove_file(format!("{}.part", artwork_path));
        }
        for extension in ["jpg", "png", "webp", "cover"] {
            let artwork = download_artwork_path(id, extension);
            let _ = fs::remove_file(&artwork);
            let _ = fs::remove_file(format!("{}.part", artwork.to_string_lossy()));
        }
    }
    db.execute("DELETE FROM downloads WHERE song_id = ?1", params![id])
        .map_err(|error| format!("download cache removal failed: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn download_start(
    item: YtItem,
    audio_quality: Opt<Keyword>,
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let audio_quality = audio_quality.into_string();
    download_single_song(item, audio_quality.as_deref(), &app, &state)
        .await
        .map_err(IpcError::from)
}

/// Downloads one song exactly the way `download_start` always has: resumable audio into the downloads
/// folder, cached thumbnail and lyrics for the song, completion recorded in `downloads`. The failure
/// reason is returned (never panics) so a whole-playlist download can record it and continue with the
/// next song instead of aborting the playlist.
async fn download_single_song(
    item: YtItem,
    audio_quality: Option<&str>,
    app: &tauri::AppHandle,
    state: &tauri::State<'_, RuntimeState>,
) -> Result<(), String> {
    let audio_quality = audio_quality.map(str::to_owned);
    let video_id = item
        .video_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "offline download requires a source videoId".to_owned())?;
    let song_id = item.id.trim().to_owned();
    if song_id.is_empty() {
        return Err("offline download song id is empty".to_owned());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = download_cancel_map()
            .lock()
            .map_err(|_| "download cancellation state poisoned".to_owned())?;
        if map.contains_key(&song_id) {
            return Err("download is already active".to_owned());
        }
        map.insert(song_id.clone(), cancel.clone());
    }
    let _active_download = ActiveDownloadGuard(song_id.clone());
    let final_path = download_cache_path(&song_id);
    let partial_path = PathBuf::from(format!("{}.part", final_path.to_string_lossy()));
    let existing_partial_bytes = fs::metadata(&partial_path)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("download cache directory failed: {error}"))?;
    }
    let expected_total: Option<i64>;
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "database state poisoned".to_owned())?;
        // The row is the resume manifest (PLAY-055): the size recorded when the partial file was started.
        expected_total = if existing_partial_bytes > 0 {
            db.query_row(
                "SELECT total_bytes FROM downloads WHERE song_id = ?1",
                params![song_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(|error| format!("download resume state read failed: {error}"))?
            .flatten()
        } else {
            None
        };
        if let Some(old_artwork) = db
            .query_row(
                "SELECT artwork_path FROM downloads WHERE song_id = ?1",
                params![song_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("download artwork state read failed: {error}"))?
            .flatten()
        {
            let _ = fs::remove_file(old_artwork);
        }
        db.execute("INSERT INTO songs (id, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, kind, saved_at, explicit, music_video_type, liked, liked_date, in_library, is_video, uploaded, youtube_liked, album_id, duration) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, NULL, 0, 0, 0, 0, ?13, ?14) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, thumbnail=excluded.thumbnail, video_id=excluded.video_id, set_video_id=excluded.set_video_id, kind=excluded.kind, album_id=excluded.album_id, duration=excluded.duration", params![song_id, item.title, item.subtitle, item.thumbnail, item.browse_id, item.playlist_id, item.video_id, item.set_video_id, item.kind, now_seconds(), if item.explicit { 1 } else { 0 }, item.music_video_type, item.album_id, 0]).map_err(|error| format!("download metadata save failed: {error}"))?;
        db.execute("INSERT INTO downloads (song_id, path, bytes, total_bytes, state, error, lyrics_cached, artwork_path, downloaded_at)
 VALUES (?1, ?2, ?3, NULL, 'downloading', NULL, 0, NULL, ?4) ON CONFLICT(song_id) DO UPDATE SET path=excluded.path, bytes=excluded.bytes, total_bytes=CASE WHEN excluded.bytes > 0 THEN downloads.total_bytes ELSE NULL END, state='downloading', error=NULL, lyrics_cached=0, artwork_path=NULL, downloaded_at=excluded.downloaded_at", params![song_id, final_path.to_string_lossy().to_string(), existing_partial_bytes, now_seconds()]).map_err(|error| format!("download state init failed: {error}"))?;
        if let Some(info) = read_download_info(&db, &song_id)? {
            emit_download(app, &info);
        }
    }
    let state_for_lyrics = state.clone();
    let result: Result<(i64, Option<i64>, bool, Option<String>), String> = async {
        let quality = normalize_audio_quality(audio_quality.as_deref());
        let mut payload = resolve_player_payload(video_id, item.playlist_id.as_deref(), quality, state).await?;
        {
            let db = state.db.lock().map_err(|_| "database state poisoned".to_owned())?;
            db.execute("UPDATE songs SET duration = ?1 WHERE id = ?2 AND duration = 0", params![payload.duration, song_id]).map_err(|error| format!("download duration state failed: {error}"))?;
        }
        // The client's default 20s timeout would abort any download that legitimately takes longer (a large
        // file on a slow connection); override it with a generous cap, and catch a truly stalled connection
        // separately below via a per-chunk idle timeout instead. Every request is a range request (like the
        // audio element's), and a URL the media server refuses is re-resolved with another client.
        let mut offset = existing_partial_bytes;
        let mut requests = 0_u8;
        let (response, decision) = loop {
            requests += 1;
            let response = http().get(&payload.stream_url).timeout(TRANSFER_TIMEOUT).header(RANGE, format!("bytes={offset}-")).send().await.map_err(|error| format!("audio cache request failed: {}", resolver::redact(&error.without_url().to_string())))?;
            let status = response.status();
            let content_range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()).map(str::to_owned);
            let decision = download_resume::resume_decision(offset, status.as_u16(), content_range.as_deref(), expected_total);
            if requests < MAX_STREAM_REQUESTS {
                match download_retry(status, decision) {
                    DownloadRetry::Reresolve => {
                        mark_stream_refused(video_id, payload.source_client.as_deref());
                        payload = resolve_player_payload(video_id, item.playlist_id.as_deref(), quality, state).await?;
                        continue;
                    }
                    DownloadRetry::Restart => {
                        offset = 0;
                        let _ = fs::remove_file(&partial_path);
                        continue;
                    }
                    DownloadRetry::Proceed => {}
                }
            }
            if !status.is_success() {
                return Err(format!("audio cache response failed: HTTP {status} from {}", payload.source_client.as_deref().unwrap_or("YouTube")));
            }
            if decision == download_resume::Resume::Restart {
                let _ = fs::remove_file(&partial_path);
                return Err("the partial download no longer matches the stream; try again to start over".to_owned());
            }
            break (response, decision);
        };
        let resume = decision == download_resume::Resume::Append;
        if offset > 0 && !resume { let _ = fs::remove_file(&partial_path); }
        let total_bytes = response.content_length().map(|value| value as i64).map(|value| if resume { value + offset } else { value });
        {
            let db = state.db.lock().map_err(|_| "database state poisoned".to_owned())?;
            db.execute("UPDATE downloads SET total_bytes = ?1 WHERE song_id = ?2", params![total_bytes, song_id]).map_err(|error| format!("download size state failed: {error}"))?;
        }
        let bytes = download_resume::write_body(response.bytes_stream(), &partial_path, resume, offset, &cancel, STALL_TIMEOUT, |bytes| {
            let db = state.db.lock().map_err(|_| "database state poisoned".to_owned())?;
            db.execute("UPDATE downloads SET bytes = ?1 WHERE song_id = ?2", params![bytes, song_id]).map_err(|error| format!("download progress state failed: {error}"))?;
            if let Some(info) = read_download_info(&db, &song_id)? { emit_download(app, &info); }
            Ok(())
        }).await?;
        if !player_cache::transfer_complete(bytes, total_bytes) {
            // The partial file is kept so the next attempt resumes from it.
            return Err(format!("download incomplete: received {bytes} of {} bytes", total_bytes.unwrap_or(0)));
        }
        fs::rename(&partial_path, &final_path).map_err(|error| format!("download cache finalize failed: {error}"))?;
        let artwork_path = cache_download_artwork(&song_id, item.thumbnail.as_deref()).await;
        let artist = item.artists.iter().map(|value| value.name.as_str()).collect::<Vec<_>>().join(", ");
        let artist = if artist.trim().is_empty() { item.subtitle.clone() } else { artist };
        let lyric_duration = payload.duration.clamp(0, i32::MAX as i64) as i32;
        let lyrics_results = fetch_all_enabled_lyrics(&item.title, &artist, lyric_duration, item.album_title.as_deref(), Some(video_id), &state_for_lyrics).await.unwrap_or_default();
        let lyrics_cached = !lyrics_results.is_empty();
        let lyrics_cache_id = format!("lyrics:{}:{}", clean_lyrics_title(&item.title).to_lowercase(), clean_lyrics_artist(&artist).to_lowercase());
        let db = state.db.lock().map_err(|_| "database state poisoned".to_owned())?;
        for (index, lyrics) in lyrics_results.iter().enumerate() {
            if index == 0 { cache_lyrics_payload(&db, &lyrics_cache_id, lyrics)?; }
            else { cache_lyrics_variant(&db, &lyrics_cache_id, lyrics)?; }
        }
        db.execute("UPDATE downloads SET bytes = ?1, total_bytes = ?2, state = 'completed', error = NULL, lyrics_cached = ?3, artwork_path = ?4 WHERE song_id = ?5", params![bytes, total_bytes.or(Some(bytes)), if lyrics_cached { 1 } else { 0 }, artwork_path, song_id]).map_err(|error| format!("download completion state failed: {error}"))?;
        if let Some(info) = read_download_info(&db, &song_id)? { emit_download(app, &info); }
        Ok((bytes, total_bytes, lyrics_cached, artwork_path))
    }.await;
    download_cancel_map()
        .lock()
        .map_err(|_| "download cancellation state poisoned".to_owned())?
        .remove(&song_id);
    if let Err(error) = &result {
        let retained_bytes = fs::metadata(&partial_path)
            .map(|metadata| metadata.len() as i64)
            .unwrap_or(0);
        let state_name = if error == download_resume::CANCELLED {
            "cancelled"
        } else {
            "failed"
        };
        let db = state
            .db
            .lock()
            .map_err(|_| "database state poisoned".to_owned())?;
        if let Some(info) = read_download_info(&db, &song_id)? {
            if let Some(artwork_path) = info.artwork_path {
                let _ = fs::remove_file(&artwork_path);
                let _ = fs::remove_file(format!("{}.part", artwork_path));
            }
        }
        db.execute("UPDATE downloads SET bytes = ?1, state = ?2, error = ?3, artwork_path = NULL WHERE song_id = ?4", params![retained_bytes, state_name, error, song_id]).map_err(|db_error| format!("download failure state failed: {db_error}"))?;
        if let Some(info) = read_download_info(&db, &song_id)? {
            emit_download(app, &info);
        }
    }
    result.map(|_| ())
}

#[tauri::command]
pub fn library_downloads(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<LocalItem>> {
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let mut statement = db.prepare("SELECT s.id, s.kind, s.title, s.subtitle, s.thumbnail, d.artwork_path, s.video_id, s.set_video_id, s.playlist_id, s.explicit, s.music_video_type, s.album_id, d.path, d.bytes, d.total_bytes, d.lyrics_cached, s.duration FROM downloads d INNER JOIN songs s ON s.id = d.song_id WHERE d.state = 'completed' ORDER BY d.downloaded_at DESC").map_err(|error| format!("downloaded catalog query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let path: String = row.get(12)?;
            let remote_thumbnail: Option<String> = row.get(4)?;
            let artwork_path: Option<String> = row.get(5)?;
            let thumbnail = artwork_path
                .filter(|value| Path::new(value).is_file())
                .or(remote_thumbnail);
            Ok(LocalItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail,
                artists: Vec::new(),
                browse_id: None,
                playlist_id: row.get(8)?,
                video_id: row.get(6)?,
                set_video_id: row.get(7)?,
                play_playlist_id: row.get(8)?,
                play_video_id: row.get(6)?,
                params: None,
                explicit: row.get::<_, i64>(9)? != 0,
                music_video_type: row.get(10)?,
                history_remove_token: None,
                album_id: row.get(11)?,
                album_title: None,
                local_path: path,
                duration: row.get(16)?,
            })
        })
        .map_err(|error| format!("downloaded catalog rows failed: {error}"))?;
    let mut items = Vec::new();
    for row in rows {
        let item = row.map_err(|error| format!("downloaded catalog row decode failed: {error}"))?;
        if Path::new(&item.local_path).is_file() {
            items.push(item);
        }
    }
    Ok(items)
}
// Whole-playlist downloads: one user action downloads every song of a playlist (audio, thumbnail
// and lyrics per song, via the single-song downloader above) plus the playlist's own photo, and
// saves the playlist into the Library so it plays offline. A song that fails is recorded in
// `playlist_download_songs` and does not abort the rest; progress is the `playlist_downloads` row
// (polled by the UI) plus the existing per-song `download-state` events.

/// Cancellation flags for active whole-playlist downloads, keyed by playlist id (mirrors the
/// per-song `download_cancel_map` in lib.rs). Presence in the map means a playlist download is active.
static PLAYLIST_DOWNLOAD_CANCELS: std::sync::OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    std::sync::OnceLock::new();

fn playlist_download_cancel_map() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    PLAYLIST_DOWNLOAD_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Song currently downloading for each active playlist download, so cancelling the playlist can also
/// stop the song download in flight instead of waiting for it to finish.
static PLAYLIST_DOWNLOAD_CURRENT_SONG: std::sync::OnceLock<Mutex<HashMap<String, String>>> =
    std::sync::OnceLock::new();

fn playlist_download_current_song_map() -> &'static Mutex<HashMap<String, String>> {
    PLAYLIST_DOWNLOAD_CURRENT_SONG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes a playlist from the active-download maps on every exit path of `playlist_download_start`
/// (mirrors `ActiveDownloadGuard` for single songs).
struct ActivePlaylistDownloadGuard(String);

impl Drop for ActivePlaylistDownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = playlist_download_cancel_map().lock() {
            map.remove(&self.0);
        }
        if let Ok(mut current) = playlist_download_current_song_map().lock() {
            current.remove(&self.0);
        }
    }
}

/// A playlist id YouTube Music itself owns (synced or browsable), so the backend can fetch the full
/// song list from YouTube when the frontend only loaded the first page. Local playlists are
/// `LOCAL_<millis>` and never reach the remote fetch.
fn is_youtube_playlist_id(id: &str) -> bool {
    ["PL", "OLAK", "RD", "UU", "LM"]
        .iter()
        .any(|prefix| id.starts_with(prefix))
}

/// Merges the songs the frontend already loaded with the full list fetched from YouTube, keeping the
/// frontend order first and dropping duplicates by song id. (A playlist can legitimately contain the
/// same song twice, but downloading it twice is not useful.)
fn merge_playlist_songs(provided: &[YtItem], fetched: &[YtItem]) -> Vec<YtItem> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for item in provided.iter().chain(fetched.iter()) {
        if item.id.trim().is_empty() || !seen.insert(item.id.clone()) {
            continue;
        }
        merged.push(item.clone());
    }
    merged
}

/// Final state of a playlist download from its per-song outcome.
fn final_playlist_state(completed: i64, failed: i64, cancelled: bool) -> &'static str {
    if cancelled {
        "cancelled"
    } else if failed == 0 {
        "completed"
    } else if completed == 0 {
        "failed"
    } else {
        "partial"
    }
}

fn read_playlist_download_status(
    db: &Connection,
    playlist_id: &str,
) -> Result<Option<PlaylistDownloadStatus>, String> {
    let Some(row) = db
        .query_row(
            "SELECT playlist_id, title, thumbnail, artwork_path, state, total_songs, completed_songs, failed_songs, error, started_at, updated_at FROM playlist_downloads WHERE playlist_id = ?1",
            params![playlist_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("playlist download state read failed: {error}"))?
    else {
        return Ok(None);
    };
    let (
        playlist_id,
        title,
        thumbnail,
        artwork_path,
        state,
        total_songs,
        completed_songs,
        failed_songs,
        error,
        started_at,
        updated_at,
    ) = row;
    let mut statement = db
        .prepare("SELECT song_id, title, error FROM playlist_download_songs WHERE playlist_id = ?1 AND state = 'failed' ORDER BY rowid")
        .map_err(|error| format!("playlist download failures query failed: {error}"))?;
    let failures = statement
        .query_map(params![playlist_id], |row| {
            Ok(PlaylistDownloadFailure {
                song_id: row.get(0)?,
                title: row.get(1)?,
                error: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })
        .map_err(|error| format!("playlist download failures rows failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("playlist download failure decode failed: {error}"))?;
    Ok(Some(PlaylistDownloadStatus {
        playlist_id,
        title,
        thumbnail,
        artwork_path,
        state,
        total_songs,
        completed_songs,
        failed_songs,
        failures,
        error,
        started_at,
        updated_at,
    }))
}

/// Recomputes a playlist download's completed/failed counts from its per-song rows.
fn refresh_playlist_download_counts(db: &Connection, playlist_id: &str) -> Result<(), String> {
    db.execute(
        "UPDATE playlist_downloads SET completed_songs = (SELECT COUNT(*) FROM playlist_download_songs WHERE playlist_id = ?1 AND state = 'completed'), failed_songs = (SELECT COUNT(*) FROM playlist_download_songs WHERE playlist_id = ?1 AND state = 'failed'), updated_at = ?2 WHERE playlist_id = ?1",
        params![playlist_id, now_seconds()],
    )
    .map_err(|error| format!("playlist download progress update failed: {error}"))?;
    Ok(())
}

/// Saves the playlist and its songs in the Library (so the downloaded playlist appears there with its
/// songs) and (re)creates the per-song download rows: already-downloaded songs start completed, songs
/// with no source video start failed with the reason, the rest pending. Re-running after a partial
/// download keeps the completed songs and retries only the rest.
fn upsert_playlist_download_membership(
    db: &Connection,
    playlist: &YtItem,
    songs: &[YtItem],
) -> Result<(), String> {
    let playlist_id = playlist.id.trim();
    let source = if playlist_id.starts_with("LOCAL_") {
        "local"
    } else {
        "youtube"
    };
    db.execute(
        "INSERT INTO playlists (id, title, subtitle, thumbnail, kind, saved_at, source) VALUES (?1, ?2, ?3, ?4, 'playlist', ?5, ?6) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, thumbnail=excluded.thumbnail",
        params![playlist_id, playlist.title, playlist.subtitle, playlist.thumbnail, now_seconds(), source],
    )
    .map_err(|error| format!("playlist download library save failed: {error}"))?;
    let mut existing: HashSet<String> = HashSet::new();
    {
        let mut statement = db
            .prepare("SELECT song_id FROM playlist_songs WHERE playlist_id = ?1")
            .map_err(|error| format!("playlist download membership read failed: {error}"))?;
        let rows = statement
            .query_map(params![playlist_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("playlist download membership rows failed: {error}"))?;
        for row in rows {
            existing.insert(
                row.map_err(|error| {
                    format!("playlist download membership decode failed: {error}")
                })?,
            );
        }
    }
    let mut position: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_songs WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("playlist download position read failed: {error}"))?;
    db.execute(
        "DELETE FROM playlist_download_songs WHERE playlist_id = ?1",
        params![playlist_id],
    )
    .map_err(|error| format!("playlist download songs reset failed: {error}"))?;
    for song in songs {
        // Same song upsert as adding a song to a playlist: metadata only, never clobbers `in_library`
        // or a duration the song already has.
        db.execute("INSERT INTO songs (id, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, kind, saved_at, explicit, music_video_type, in_library, is_video) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, thumbnail=excluded.thumbnail, browse_id=excluded.browse_id, playlist_id=excluded.playlist_id, video_id=excluded.video_id, set_video_id=excluded.set_video_id, kind=excluded.kind, explicit=excluded.explicit, music_video_type=excluded.music_video_type, is_video=excluded.is_video", params![song.id, song.title, song.subtitle, song.thumbnail, song.browse_id, song.playlist_id, song.video_id, song.set_video_id, song.kind, now_seconds(), if song.explicit { 1 } else { 0 }, song.music_video_type, if song.music_video_type.as_deref().is_some_and(|value| value != "MUSIC_VIDEO_TYPE_ATV") { 1 } else { 0 }]).map_err(|error| format!("playlist download song save failed: {error}"))?;
        if !existing.contains(&song.id) {
            db.execute(
                "INSERT INTO playlist_songs (playlist_id, position, song_id) VALUES (?1, ?2, ?3)",
                params![playlist_id, position, song.id],
            )
            .map_err(|error| format!("playlist download membership save failed: {error}"))?;
            existing.insert(song.id.clone());
            position += 1;
        }
        let already_downloaded = matches!(
            read_download_info(db, &song.id)?,
            Some(info) if info.state == "completed"
        );
        let has_source = song
            .video_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
        let (song_state, song_error): (&str, Option<String>) = if already_downloaded {
            ("completed", None)
        } else if !has_source {
            (
                "failed",
                Some("no source video available for offline download".to_owned()),
            )
        } else {
            ("pending", None)
        };
        db.execute(
            "INSERT INTO playlist_download_songs (playlist_id, song_id, title, state, error) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![playlist_id, song.id, song.title, song_state, song_error],
        )
        .map_err(|error| format!("playlist download song state init failed: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn playlist_download_start(
    playlist: YtItem,
    songs: Vec<YtItem>,
    audio_quality: Opt<Keyword>,
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<PlaylistDownloadStatus> {
    let audio_quality = audio_quality.into_string();
    let playlist_id = playlist.id.trim().to_owned();
    if playlist_id.is_empty() {
        return Err(IpcError::from(
            "playlist download playlist id is empty".to_owned(),
        ));
    }
    if songs.is_empty() {
        return Err(IpcError::from(
            "playlist download needs at least one song".to_owned(),
        ));
    }
    if songs.len() > 5_000 {
        return Err(IpcError::from(format!(
            "playlist download supports at most 5000 songs at once; this playlist has {}",
            songs.len()
        )));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = playlist_download_cancel_map()
            .lock()
            .map_err(|_| "playlist download state poisoned".to_owned())?;
        if map.contains_key(&playlist_id) {
            return Err(IpcError::from(
                "playlist download is already active".to_owned(),
            ));
        }
        map.insert(playlist_id.clone(), cancel.clone());
    }
    let _active_playlist = ActivePlaylistDownloadGuard(playlist_id.clone());
    // The frontend passes the songs it already loaded; a YouTube playlist opened in the app usually
    // only loaded its first page, so top the list up from YouTube when signed in. A fetch failure
    // falls back to the songs the user could already see rather than failing the download.
    let mut merged = merge_playlist_songs(&songs, &[]);
    if is_youtube_playlist_id(&playlist_id) {
        if let Ok(Some(session)) = auth_session(&state) {
            if let Ok(fetched) = fetch_all_playlist_songs(&session, &playlist_id).await {
                merged = merge_playlist_songs(&songs, &fetched);
            }
        }
    }
    if merged.is_empty() {
        return Err(IpcError::from(
            "playlist download needs at least one song".to_owned(),
        ));
    }
    let artwork_path = cache_playlist_artwork(&playlist_id, playlist.thumbnail.as_deref()).await;
    let started_at = now_seconds();
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "database state poisoned".to_owned())?;
        upsert_playlist_download_membership(&db, &playlist, &merged)?;
        db.execute("INSERT INTO playlist_downloads (playlist_id, title, thumbnail, artwork_path, state, total_songs, completed_songs, failed_songs, error, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'downloading', ?5, 0, 0, NULL, ?6, ?6) ON CONFLICT(playlist_id) DO UPDATE SET title=excluded.title, thumbnail=excluded.thumbnail, artwork_path=excluded.artwork_path, state='downloading', total_songs=excluded.total_songs, completed_songs=0, failed_songs=0, error=NULL, started_at=excluded.started_at, updated_at=excluded.updated_at", params![playlist_id, playlist.title, playlist.thumbnail, artwork_path, merged.len() as i64, started_at]).map_err(|error| format!("playlist download state init failed: {error}"))?;
        refresh_playlist_download_counts(&db, &playlist_id)?;
    }
    let mut cancelled = false;
    for song in &merged {
        if cancel.load(Ordering::Acquire) {
            cancelled = true;
            break;
        }
        let song_id = song.id.clone();
        if let Ok(mut current) = playlist_download_current_song_map().lock() {
            current.insert(playlist_id.clone(), song_id.clone());
        }
        let row_state = {
            let db = state
                .db
                .lock()
                .map_err(|_| "database state poisoned".to_owned())?;
            db.query_row(
                "SELECT state FROM playlist_download_songs WHERE playlist_id = ?1 AND song_id = ?2",
                params![playlist_id, song_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("playlist download song state read failed: {error}"))?
        };
        match row_state.as_deref() {
            // Already downloaded, or un-downloadable and recorded up front: nothing to do.
            Some("completed") | Some("failed") => {}
            _ => {
                {
                    let db = state
                        .db
                        .lock()
                        .map_err(|_| "database state poisoned".to_owned())?;
                    db.execute(
                        "UPDATE playlist_download_songs SET state = 'downloading', error = NULL WHERE playlist_id = ?1 AND song_id = ?2",
                        params![playlist_id, song_id],
                    )
                    .map_err(|error| {
                        format!("playlist download song state update failed: {error}")
                    })?;
                }
                let result =
                    download_single_song(song.clone(), audio_quality.as_deref(), &app, &state)
                        .await;
                let db = state
                    .db
                    .lock()
                    .map_err(|_| "database state poisoned".to_owned())?;
                match result {
                    Ok(()) => {
                        db.execute(
                            "UPDATE playlist_download_songs SET state = 'completed', error = NULL WHERE playlist_id = ?1 AND song_id = ?2",
                            params![playlist_id, song_id],
                        )
                        .map_err(|error| {
                            format!("playlist download song completion failed: {error}")
                        })?;
                    }
                    Err(error) => {
                        if cancel.load(Ordering::Acquire) {
                            // The run was cancelled mid-song: the song simply was not finished, it
                            // did not fail, so it stays retryable instead of listed as failed.
                            db.execute(
                                "UPDATE playlist_download_songs SET state = 'pending', error = NULL WHERE playlist_id = ?1 AND song_id = ?2",
                                params![playlist_id, song_id],
                            )
                            .map_err(|error| {
                                format!("playlist download song reset failed: {error}")
                            })?;
                        } else {
                            db.execute(
                                "UPDATE playlist_download_songs SET state = 'failed', error = ?1 WHERE playlist_id = ?2 AND song_id = ?3",
                                params![error, playlist_id, song_id],
                            )
                            .map_err(|error| {
                                format!("playlist download song failure save failed: {error}")
                            })?;
                        }
                    }
                }
                refresh_playlist_download_counts(&db, &playlist_id)?;
            }
        }
        if let Ok(mut current) = playlist_download_current_song_map().lock() {
            current.remove(&playlist_id);
        }
    }
    if cancel.load(Ordering::Acquire) {
        cancelled = true;
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    refresh_playlist_download_counts(&db, &playlist_id)?;
    let (completed, failed) = db
        .query_row(
            "SELECT completed_songs, failed_songs FROM playlist_downloads WHERE playlist_id = ?1",
            params![playlist_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|error| format!("playlist download counts read failed: {error}"))?;
    let final_state = final_playlist_state(completed, failed, cancelled);
    let summary_error: Option<String> = match final_state {
        "completed" | "cancelled" => None,
        _ => Some(format!(
            "{failed} of {} songs failed to download",
            completed + failed
        )),
    };
    db.execute(
        "UPDATE playlist_downloads SET state = ?1, error = ?2, updated_at = ?3 WHERE playlist_id = ?4",
        params![final_state, summary_error, now_seconds(), playlist_id],
    )
    .map_err(|error| format!("playlist download completion failed: {error}"))?;
    let status = read_playlist_download_status(&db, &playlist_id)?
        .ok_or_else(|| "playlist download status was removed".to_owned())?;
    Ok(status)
}

#[tauri::command]
pub fn playlist_download_status(
    playlist_id: LibraryId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Option<PlaylistDownloadStatus>> {
    let playlist_id = playlist_id.into_inner();
    let id = playlist_id.trim();
    if id.is_empty() {
        return Err(IpcError::from(
            "playlist download playlist id is empty".to_owned(),
        ));
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    Ok(read_playlist_download_status(&db, id)?)
}

#[tauri::command]
pub fn playlist_downloads(
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Vec<PlaylistDownloadStatus>> {
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let mut statement = db
        .prepare("SELECT playlist_id FROM playlist_downloads ORDER BY updated_at DESC")
        .map_err(|error| format!("playlist downloads query failed: {error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("playlist downloads rows failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("playlist downloads row decode failed: {error}"))?;
    let mut statuses = Vec::new();
    for id in ids {
        if let Some(status) = read_playlist_download_status(&db, &id)? {
            statuses.push(status);
        }
    }
    Ok(statuses)
}

#[tauri::command]
pub fn playlist_download_cancel(playlist_id: LibraryId) -> IpcResult<()> {
    let playlist_id = playlist_id.into_inner();
    let id = playlist_id.trim();
    if id.is_empty() {
        return Err(IpcError::from(
            "playlist download playlist id is empty".to_owned(),
        ));
    }
    let map = playlist_download_cancel_map()
        .lock()
        .map_err(|_| "playlist download state poisoned".to_owned())?;
    let Some(flag) = map.get(id) else {
        return Err(IpcError::from(
            "playlist download is not currently active".to_owned(),
        ));
    };
    flag.store(true, Ordering::Release);
    // Stop the song downloading right now as well, instead of waiting for it to finish.
    if let Ok(current) = playlist_download_current_song_map().lock() {
        if let Some(song_id) = current.get(id) {
            if let Ok(cancels) = download_cancel_map().lock() {
                if let Some(song_flag) = cancels.get(song_id) {
                    song_flag.store(true, Ordering::Release);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn playlist_download_remove(
    playlist_id: LibraryId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let playlist_id = playlist_id.into_inner();
    let id = playlist_id.trim();
    if id.is_empty() {
        return Err(IpcError::from(
            "playlist download playlist id is empty".to_owned(),
        ));
    }
    if playlist_download_cancel_map()
        .lock()
        .map_err(|_| "playlist download state poisoned".to_owned())?
        .contains_key(id)
    {
        return Err(IpcError::from(
            "cancel the active playlist download before removing it".to_owned(),
        ));
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    // Only the playlist-download record and its photo go: the playlist itself, its songs and their
    // individual downloads stay, and remain removable one by one as before.
    if let Some(status) = read_playlist_download_status(&db, id)? {
        if let Some(artwork_path) = status.artwork_path {
            let _ = fs::remove_file(&artwork_path);
            let _ = fs::remove_file(format!("{}.part", artwork_path));
        }
    }
    db.execute(
        "DELETE FROM playlist_download_songs WHERE playlist_id = ?1",
        params![id],
    )
    .map_err(|error| format!("playlist download songs removal failed: {error}"))?;
    db.execute(
        "DELETE FROM playlist_downloads WHERE playlist_id = ?1",
        params![id],
    )
    .map_err(|error| format!("playlist download removal failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: &str, video_id: Option<&str>) -> YtItem {
        YtItem {
            id: id.to_owned(),
            kind: "song".to_owned(),
            title: format!("Song {id}"),
            subtitle: "Artist".to_owned(),
            thumbnail: None,
            artists: Vec::new(),
            browse_id: None,
            playlist_id: None,
            video_id: video_id.map(str::to_owned),
            set_video_id: None,
            play_playlist_id: None,
            play_video_id: None,
            params: None,
            explicit: false,
            music_video_type: None,
            history_remove_token: None,
            album_id: None,
            album_title: None,
        }
    }

    fn playlist(id: &str) -> YtItem {
        YtItem {
            id: id.to_owned(),
            kind: "playlist".to_owned(),
            title: "Mix".to_owned(),
            subtitle: "Playlist".to_owned(),
            thumbnail: Some("https://i.ytimg.com/vi/x/hqdefault.jpg".to_owned()),
            artists: Vec::new(),
            browse_id: Some(id.to_owned()),
            playlist_id: Some(id.to_owned()),
            video_id: None,
            set_video_id: None,
            play_playlist_id: Some(id.to_owned()),
            play_video_id: None,
            params: None,
            explicit: false,
            music_video_type: None,
            history_remove_token: None,
            album_id: None,
            album_title: None,
        }
    }

    #[test]
    fn youtube_playlist_ids_are_recognised_and_local_ones_are_not() {
        assert!(is_youtube_playlist_id("PL1234567890abcdef"));
        assert!(is_youtube_playlist_id("OLAK5uy_test"));
        assert!(is_youtube_playlist_id("RD123"));
        assert!(is_youtube_playlist_id("UU123"));
        assert!(is_youtube_playlist_id("LM"));
        assert!(!is_youtube_playlist_id("LOCAL_1793000000000"));
        assert!(!is_youtube_playlist_id(""));
        assert!(!is_youtube_playlist_id("spotify:playlist:abc"));
    }

    #[test]
    fn merge_keeps_frontend_order_and_drops_duplicate_downloads() {
        let provided = vec![song("a", Some("va")), song("b", Some("vb"))];
        let fetched = vec![
            song("b", Some("vb")),
            song("c", Some("vc")),
            song("a", Some("va")),
        ];
        let merged = merge_playlist_songs(&provided, &fetched);
        assert_eq!(
            merged
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert_eq!(merge_playlist_songs(&[], &fetched).len(), 3);
        assert!(merge_playlist_songs(&[song("", Some("vx"))], &[]).is_empty());
    }

    #[test]
    fn final_state_distinguishes_completed_partial_failed_and_cancelled() {
        assert_eq!(final_playlist_state(5, 0, false), "completed");
        assert_eq!(final_playlist_state(3, 2, false), "partial");
        assert_eq!(final_playlist_state(0, 4, false), "failed");
        assert_eq!(final_playlist_state(3, 2, true), "cancelled");
        assert_eq!(final_playlist_state(0, 0, true), "cancelled");
    }

    #[test]
    fn membership_upsert_puts_the_playlist_in_the_library_and_marks_undownloadable_songs_failed() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA_SQL).unwrap();
        let songs = vec![
            song("a", Some("va")),
            song("b", None),
            song("a", Some("va")),
        ];
        // The duplicate "a" is a second occurrence in the same playlist; the merge step normally
        // drops it, so the membership upsert sees it once here via the deduped list.
        let songs = merge_playlist_songs(&songs, &[]);
        upsert_playlist_download_membership(&db, &playlist("PL1"), &songs).unwrap();
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = 'PL1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
        let in_library: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM playlists WHERE id = 'PL1' AND title = 'Mix'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(in_library, 1);
        let failed: String = db
            .query_row(
                "SELECT error FROM playlist_download_songs WHERE playlist_id = 'PL1' AND song_id = 'b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(failed.contains("no source video"), "{failed}");
        // Re-running keeps the membership (no duplicate positions) and resets the per-song rows.
        upsert_playlist_download_membership(&db, &playlist("PL1"), &songs).unwrap();
        let count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = 'PL1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn status_round_trip_reports_counts_and_failures() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA_SQL).unwrap();
        let songs = vec![song("a", Some("va")), song("b", None)];
        upsert_playlist_download_membership(&db, &playlist("PL9"), &songs).unwrap();
        db.execute(
            "INSERT INTO playlist_downloads (playlist_id, title, thumbnail, artwork_path, state, total_songs, completed_songs, failed_songs, error, started_at, updated_at) VALUES ('PL9', 'Mix', NULL, NULL, 'downloading', 2, 0, 0, NULL, 7, 7)",
            [],
        )
        .unwrap();
        refresh_playlist_download_counts(&db, "PL9").unwrap();
        let status = read_playlist_download_status(&db, "PL9").unwrap().unwrap();
        assert_eq!(status.total_songs, 2);
        assert_eq!(status.completed_songs, 0);
        assert_eq!(status.failed_songs, 1);
        assert_eq!(status.failures.len(), 1);
        assert_eq!(status.failures[0].song_id, "b");
        assert!(read_playlist_download_status(&db, "missing")
            .unwrap()
            .is_none());
    }
}
