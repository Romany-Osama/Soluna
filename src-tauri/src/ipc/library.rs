//! IPC commands: Soluna's library, playlists, history, stats, Speed Dial and the YouTube Music library (S5-003; owner `library` in docs/ipc-commands.md)
#![allow(unused_imports)]

use crate::*;
use rusqlite::Transaction;

#[tauri::command]
pub async fn ytm_delete_uploaded_song(
    entity_id: Token,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<bool> {
    let entity_id = entity_id.into_inner();
    let entity_id = entity_id.trim();
    if entity_id.is_empty() {
        return Err(IpcError::from("uploaded entity id is empty".to_owned()));
    }
    let session = auth_session(&state)?.ok_or_else(|| {
        "Deleting an uploaded song requires a connected YouTube Music account".to_owned()
    })?;
    let response = post_with_query(
        "music/delete_privately_owned_entity",
        json!({ "context": context(&session.visitor_data, false, None), "entityId": entity_id }),
        Some(&session),
        &[("key", YOUTUBE_API_KEY)],
    )
    .await?;
    let processed = response
        .get("feedbackResponses")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().all(|item| {
                item.get("isProcessed")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            })
        })
        .unwrap_or(true);
    if !processed {
        return Err(IpcError::from(
            "YouTube Music did not confirm uploaded song deletion".to_owned(),
        ));
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    db.execute(
        "UPDATE songs SET uploaded = 0, in_library = 0 WHERE id = ?1 OR video_id = ?1",
        params![entity_id],
    )
    .map_err(|error| format!("uploaded song local cleanup failed: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn ytm_podcast_channels(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let local = {
        let db = state
            .db
            .lock()
            .map_err(|_| "database state poisoned".to_owned())?;
        saved_podcast_rows(&db)?
    };
    let Some(session) = auth_session(&state)? else {
        return Ok(local);
    };
    let remote =
        fetch_all_library_items(&session, "FEmusic_library_non_music_audio_channels_list", 0)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|item| item.kind == "podcast" || item.kind == "artist")
            .collect::<Vec<_>>();
    if remote.is_empty() {
        return Ok(local);
    }
    let mut result = remote;
    for item in local {
        if !result.iter().any(|existing| existing.id == item.id) {
            result.push(item);
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn library_saved_podcasts(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    Ok(saved_podcast_rows(&db)?)
}

#[tauri::command]
pub async fn sync_youtube_library(
    mode: Keyword,
    state: tauri::State<'_, RuntimeState>,
    request_id: Opt<Token>,
) -> IpcResult<YouTubeSyncResult> {
    cancellable(
        request_id.into_string(),
        "Library sync",
        sync_youtube_library_body(mode, state),
    )
    .await
}

async fn sync_youtube_library_body(
    mode: Keyword,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<YouTubeSyncResult> {
    let mode = mode.into_inner();
    let mode = mode.trim().to_lowercase();
    if !matches!(
        mode.as_str(),
        "liked" | "library" | "uploaded" | "playlists"
    ) {
        return Err(IpcError::from(
            "YouTube library sync mode must be liked, library, uploaded, or playlists".to_owned(),
        ));
    }
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    let (liked_songs, mut library_songs, mut uploaded_songs, playlists) = if mode == "liked" {
        (
            fetch_all_playlist_songs(&session, "LM").await?,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )
    } else if mode == "library" {
        (
            Vec::new(),
            fetch_all_library_songs(&session, "FEmusic_liked_videos", None).await?,
            Vec::new(),
            Vec::new(),
        )
    } else if mode == "uploaded" {
        (
            Vec::new(),
            Vec::new(),
            fetch_all_library_songs(&session, "FEmusic_library_privately_owned_tracks", Some(1))
                .await?,
            Vec::new(),
        )
    } else {
        (
            Vec::new(),
            Vec::new(),
            Vec::new(),
            fetch_all_library_playlists(&session).await?,
        )
    };
    if mode == "library" || mode == "uploaded" {
        if mode == "library" {
            library_songs.reverse();
        } else {
            uploaded_songs.reverse();
        }
    }
    let timestamp = now_seconds();
    let mut db = state.db.lock().map_err(|_| "database state poisoned")?;
    apply_youtube_sync(
        &mut db,
        &mode,
        &liked_songs,
        &library_songs,
        &uploaded_songs,
        &playlists,
        timestamp,
    )?;
    Ok(YouTubeSyncResult {
        liked_songs: liked_songs.len(),
        library_songs: library_songs.len(),
        uploaded_songs: uploaded_songs.len(),
        playlists: playlists.len(),
    })
}

#[tauri::command]
pub async fn ytm_history(state: tauri::State<'_, RuntimeState>) -> IpcResult<RemoteHistoryPage> {
    let visitor_data = visitor(&state).await?;
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    let response = post(
        "browse",
        json!({
            "context": context(&visitor_data, true, Some(&session.data_sync_id)),
            "browseId": "FEmusic_history"
        }),
        Some(&session),
    )
    .await?;
    Ok(parse_remote_history(&response))
}

#[tauri::command]
pub async fn library_refetch_item(
    id: LibraryId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Option<YtItem>> {
    let id = id.into_inner();
    let video_id = id.trim();
    if video_id.is_empty() {
        return Err(IpcError::from("refetch item id is empty".to_owned()));
    }
    let visitor_data = visitor(&state).await?;
    let session = auth_session(&state)?;
    let data_sync_id = session.as_ref().map(|value| value.data_sync_id.as_str());
    let response = post("music/get_queue", json!({ "context": context(&visitor_data, session.is_some(), data_sync_id), "videoIds": [video_id], "playlistId": Value::Null }), session.as_ref()).await?;
    let Some(item) = parse_get_queue(&response).into_iter().next() else {
        return Ok(None);
    };
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    db.execute("UPDATE songs SET title = ?1, subtitle = ?2, thumbnail = ?3, browse_id = ?4, playlist_id = ?5, video_id = ?6, set_video_id = ?7, kind = ?8, explicit = ?9, music_video_type = ?10, album_id = ?11 WHERE id = ?12 OR video_id = ?12", params![item.title, item.subtitle, item.thumbnail, item.browse_id, item.playlist_id, item.video_id, item.set_video_id, item.kind, if item.explicit { 1 } else { 0 }, item.music_video_type, item.album_id, video_id]).map_err(|error| format!("refetched metadata update failed: {error}"))?;
    Ok(Some(item))
}

#[tauri::command]
pub fn library_save_item(item: YtItem, state: tauri::State<'_, RuntimeState>) -> IpcResult<()> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let is_video = item
        .music_video_type
        .as_deref()
        .is_some_and(|value| value != "MUSIC_VIDEO_TYPE_ATV");
    db.execute(
        "INSERT INTO songs (id, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, kind, saved_at, explicit, music_video_type, liked, liked_date, in_library, is_video, album_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, NULL, 1, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, thumbnail=excluded.thumbnail,
         browse_id=excluded.browse_id, playlist_id=excluded.playlist_id, video_id=excluded.video_id, set_video_id=excluded.set_video_id, kind=excluded.kind, saved_at=excluded.saved_at,
         explicit=excluded.explicit, music_video_type=excluded.music_video_type, in_library=1, is_video=excluded.is_video, album_id=excluded.album_id",
        params![item.id, item.title, item.subtitle, item.thumbnail, item.browse_id, item.playlist_id, item.video_id, item.set_video_id, item.kind, now_seconds(), if item.explicit { 1 } else { 0 }, item.music_video_type, if is_video { 1 } else { 0 }, item.album_id],
    ).map_err(|e| format!("library save failed: {e}"))?;
    if let (Some(album_id), Some(album_title)) =
        (item.album_id.as_deref(), item.album_title.as_deref())
    {
        db.execute(
            "INSERT INTO albums (id, playlist_id, title, thumbnail, explicit, in_library, saved_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
             ON CONFLICT(id) DO UPDATE SET playlist_id=excluded.playlist_id, title=excluded.title, thumbnail=excluded.thumbnail, explicit=excluded.explicit, in_library=1, saved_at=excluded.saved_at",
            params![album_id, item.playlist_id, album_title, item.thumbnail, if item.explicit { 1 } else { 0 }, now_seconds()],
        ).map_err(|e| format!("album save failed: {e}"))?;
        db.execute(
            "INSERT OR IGNORE INTO song_albums (song_id, album_id) VALUES (?1, ?2)",
            params![item.id, album_id],
        )
        .map_err(|e| format!("song album mapping failed: {e}"))?;
    }
    for (position, artist) in item.artists.iter().enumerate() {
        let Some(artist_id) = artist.id.as_deref().filter(|value| !value.is_empty()) else {
            continue;
        };
        db.execute(
            "INSERT INTO artists (id, name, saved_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name, saved_at=excluded.saved_at",
            params![artist_id, artist.name, now_seconds()],
        ).map_err(|e| format!("artist save failed: {e}"))?;
        db.execute(
            "INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) VALUES (?1, ?2, ?3)",
            params![item.id, artist_id, position as i64],
        )
        .map_err(|e| format!("song artist mapping failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn library_edit_item(
    item_id: LibraryId,
    title: Name,
    artist: Text,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let item_id = item_id.into_inner();
    let title = title.into_inner();
    let artist = artist.into_inner();
    let id = item_id.trim();
    let title = title.trim();
    if id.is_empty() || title.is_empty() {
        return Err(IpcError::from(
            "song edit requires a non-empty item id and title".to_owned(),
        ));
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    edit_library_item(&db, id, title, artist.trim()).map_err(IpcError::from)
}

/// Edits one library song's title and artist in the local database, in a
/// single transaction. `id`, `title` and `artist` must already be trimmed;
/// `title` must be non-empty. A non-empty artist also becomes the song's
/// subtitle, as before.
///
/// The artist edit is scoped to this song only (M2): the artist row is
/// renamed in place only when no other song maps to it; when the artist is
/// shared, just this song's mapping is re-pointed at the artist row for the
/// new name (an existing row with that name, or a fresh `local-artist:<sha1>`
/// row in the local-files convention). A song with no artist mapping gets
/// one attached instead of the edit being silently dropped. The old artist
/// row is left in place even when it becomes unmapped — it may be bookmarked
/// (see `library_artists`), and unmapped rows are invisible there anyway.
fn edit_library_item(db: &Connection, id: &str, title: &str, artist: &str) -> Result<(), String> {
    let artist = artist.trim();
    let tx = db
        .unchecked_transaction()
        .map_err(|error| format!("song edit transaction failed: {error}"))?;
    let updated = tx.execute("UPDATE songs SET title = ?1, subtitle = CASE WHEN ?2 <> '' THEN ?2 ELSE subtitle END WHERE id = ?3", params![title, artist, id]).map_err(|error| format!("song edit failed: {error}"))?;
    if updated == 0 {
        return Err("song edit target was not found in the local Soluna database".to_owned());
    }
    if !artist.is_empty() {
        let mapped = tx
            .query_row(
                "SELECT artist_id, position FROM song_artists WHERE song_id = ?1 ORDER BY position LIMIT 1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|error| format!("song artist lookup failed: {error}"))?;
        match mapped {
            Some((artist_id, position)) => {
                let current_name = tx
                    .query_row(
                        "SELECT name FROM artists WHERE id = ?1",
                        params![artist_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(|error| format!("song artist lookup failed: {error}"))?;
                // A missing artist row (a dangling mapping from an older
                // database) is repaired by the re-point below, not skipped.
                if current_name.as_deref() != Some(artist) {
                    repoint_song_artist(&tx, id, &artist_id, position, artist)?;
                }
            }
            None => {
                let target = artist_id_for_name(&tx, id, artist)?;
                tx.execute(
                    "INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) VALUES (?1, ?2, 0)",
                    params![id, target],
                )
                .map_err(|error| format!("song artist mapping failed: {error}"))?;
            }
        }
    }
    tx.commit()
        .map_err(|error| format!("song edit commit failed: {error}"))?;
    Ok(())
}

/// The artist row for `name`: an existing row with that exact name, or a
/// newly created row (see `new_artist_id`).
fn artist_id_for_name(tx: &Transaction<'_>, song_id: &str, name: &str) -> Result<String, String> {
    if let Some(id) = tx
        .query_row(
            "SELECT id FROM artists WHERE name = ?1 LIMIT 1",
            params![name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("song artist lookup failed: {error}"))?
    {
        return Ok(id);
    }
    let id = new_artist_id(tx, name, song_id)?;
    tx.execute(
        "INSERT INTO artists (id, name, saved_at) VALUES (?1, ?2, ?3)",
        params![id, name, now_seconds()],
    )
    .map_err(|error| format!("artist edit failed: {error}"))?;
    Ok(id)
}

/// The `local-artist:<sha1>` id for a name, as used for local files. Salted
/// with the song id when a row already holds that id under a different name
/// — a local-artist row renamed by the old shared-rename bug — so the new
/// artist gets its own row instead of failing on the primary key or
/// hijacking that row.
fn new_artist_id(tx: &Transaction<'_>, name: &str, song_id: &str) -> Result<String, String> {
    let base = local_artist_id(name);
    let clash = tx
        .query_row(
            "SELECT name FROM artists WHERE id = ?1",
            params![base],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("song artist lookup failed: {error}"))?;
    if clash.as_deref().is_some_and(|existing| existing != name) {
        Ok(format!("{base}-{}", &local_artist_id(song_id)[13..21]))
    } else {
        Ok(base)
    }
}

/// The deterministic `local-artist:<sha1>` id for a name (the local-files
/// convention, also used in `local_item_from_path`).
fn local_artist_id(name: &str) -> String {
    format!(
        "local-artist:{}",
        Sha1::digest(name.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

/// Re-points one song's first artist mapping at the artist row for `name`:
/// an existing row with that name wins; otherwise the shared row is renamed
/// in place when this song is its only user, and a new row is created when
/// it is shared. The old row is never deleted.
fn repoint_song_artist(
    tx: &Transaction<'_>,
    song_id: &str,
    old_artist_id: &str,
    position: i64,
    name: &str,
) -> Result<(), String> {
    if let Some(existing_id) = tx
        .query_row(
            "SELECT id FROM artists WHERE name = ?1 LIMIT 1",
            params![name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("song artist lookup failed: {error}"))?
    {
        if existing_id != old_artist_id {
            move_song_artist(tx, song_id, old_artist_id, &existing_id, position)?;
        }
        return Ok(());
    }
    let shared: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM song_artists WHERE artist_id = ?1",
            params![old_artist_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("song artist lookup failed: {error}"))?;
    if shared <= 1 {
        tx.execute(
            "UPDATE artists SET name = ?1 WHERE id = ?2",
            params![name, old_artist_id],
        )
        .map_err(|error| format!("artist edit failed: {error}"))?;
        return Ok(());
    }
    let new_id = new_artist_id(tx, name, song_id)?;
    tx.execute(
        "INSERT INTO artists (id, name, saved_at) VALUES (?1, ?2, ?3)",
        params![new_id, name, now_seconds()],
    )
    .map_err(|error| format!("artist edit failed: {error}"))?;
    move_song_artist(tx, song_id, old_artist_id, &new_id, position)?;
    Ok(())
}

/// Moves one song's mapping from `old_artist_id` to `new_artist_id`,
/// keeping its position. The delete-then-insert (rather than an UPDATE)
/// keeps the (song_id, artist_id) primary key intact when the song already
/// maps to the target artist at another position.
fn move_song_artist(
    tx: &Transaction<'_>,
    song_id: &str,
    old_artist_id: &str,
    new_artist_id: &str,
    position: i64,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM song_artists WHERE song_id = ?1 AND artist_id = ?2",
        params![song_id, old_artist_id],
    )
    .map_err(|error| format!("song artist mapping failed: {error}"))?;
    tx.execute(
        "INSERT OR IGNORE INTO song_artists (song_id, artist_id, position) VALUES (?1, ?2, ?3)",
        params![song_id, new_artist_id, position],
    )
    .map_err(|error| format!("song artist mapping failed: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_toggle_liked(
    item: YtItem,
    liked: bool,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    if item.id.trim().is_empty() {
        return Err(IpcError::from("liked item id is empty".to_owned()));
    }
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let now = now_seconds();
    db.execute(
        "INSERT INTO songs (id, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, kind, saved_at, explicit, music_video_type, liked, liked_date, in_library, is_video)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CASE WHEN ?13 = 1 THEN ?10 ELSE NULL END, 0, ?14)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, thumbnail=excluded.thumbnail, browse_id=excluded.browse_id, playlist_id=excluded.playlist_id, video_id=excluded.video_id, set_video_id=excluded.set_video_id, kind=excluded.kind, explicit=excluded.explicit, music_video_type=excluded.music_video_type, liked=excluded.liked, liked_date=excluded.liked_date, is_video=excluded.is_video",
        params![item.id, item.title, item.subtitle, item.thumbnail, item.browse_id, item.playlist_id, item.video_id, item.set_video_id, item.kind, now, if item.explicit { 1 } else { 0 }, item.music_video_type, if liked { 1 } else { 0 }, if item.music_video_type.as_deref().is_some_and(|value| value != "MUSIC_VIDEO_TYPE_ATV") { 1 } else { 0 }],
    ).map_err(|e| format!("Soluna liked state save failed: {e}"))?;
    if !liked {
        db.execute("DELETE FROM songs WHERE id = ?1 AND liked = 0 AND in_library = 0 AND NOT EXISTS (SELECT 1 FROM playlist_songs WHERE playlist_songs.song_id = songs.id) AND NOT EXISTS (SELECT 1 FROM downloads WHERE downloads.song_id = songs.id)", params![item.id]).map_err(|e| format!("Soluna liked cleanup failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ytm_remove_from_history(
    token: Token,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let token = token.into_inner();
    let token = token.trim();
    if token.is_empty() {
        return Err(IpcError::from("history feedback token is empty".to_owned()));
    }
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    Ok(send_feedback(&session, token.to_owned()).await?)
}

#[tauri::command]
pub async fn ytm_toggle_like(
    video_id: VideoId,
    liked: bool,
    item: Option<YtItem>,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let video_id = video_id.into_inner();
    let id = video_id.trim();
    if id.is_empty() {
        return Err(IpcError::from("video id is empty".to_owned()));
    }
    let visitor_data = visitor(&state).await?;
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    let endpoint = if liked {
        "like/like"
    } else {
        "like/removelike"
    };
    let response = post(endpoint, json!({ "context": context(&visitor_data, true, Some(&session.data_sync_id)), "target": { "videoId": id } }), Some(&session)).await?;
    if response.get("feedbackResponses").is_none() && response.get("actions").is_none() {
        return Err(IpcError::from(
            "YouTube Music did not return a valid like response".to_owned(),
        ));
    }
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    if let Some(item) = item {
        save_like_state(&db, &item, liked)?;
    } else {
        db.execute(
            "UPDATE songs SET youtube_liked = ?1 WHERE video_id = ?2 OR id = ?2",
            params![if liked { 1 } else { 0 }, id],
        )
        .map_err(|e| format!("like state update failed: {e}"))?;
    }
    if !liked {
        db.execute("DELETE FROM songs WHERE (video_id = ?1 OR id = ?1) AND in_library = 0 AND liked = 0 AND youtube_liked = 0 AND uploaded = 0 AND NOT EXISTS (SELECT 1 FROM playlist_songs WHERE playlist_songs.song_id = songs.id) AND NOT EXISTS (SELECT 1 FROM downloads WHERE downloads.song_id = songs.id)", params![id]).map_err(|e| format!("like cleanup failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ytm_toggle_library(
    video_id: VideoId,
    add_to_library: bool,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let video_id = video_id.into_inner();
    let id = video_id.trim();
    if id.is_empty() {
        return Err(IpcError::from("video id is empty".to_owned()));
    }
    let visitor_data = visitor(&state).await?;
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    let next_response = post("next", json!({ "context": context(&visitor_data, true, Some(&session.data_sync_id)), "videoId": id }), Some(&session)).await?;
    let (add_token, remove_token) =
        find_library_tokens_for_video(&next_response, id).ok_or_else(|| {
            "YouTube Music returned no library feedback tokens; sign-in may be required".to_owned()
        })?;
    let token = if add_to_library {
        add_token
    } else {
        remove_token
    }
    .ok_or_else(|| {
        "YouTube Music did not expose the requested library operation for this song".to_owned()
    })?;
    Ok(send_feedback(&session, token).await?)
}

#[tauri::command]
pub fn library_item_state(
    id: LibraryId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<LibraryItemState> {
    let id = id.into_inner();
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let pinned = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM speed_dial WHERE id = ?1)",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Speed Dial state read failed: {error}"))?
        != 0;
    let podcast_saved = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM podcasts WHERE id = ?1 AND bookmarked_at IS NOT NULL)",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("podcast state read failed: {error}"))?
        != 0;
    let item_state = db.query_row("SELECT liked, youtube_liked, in_library, uploaded FROM songs WHERE id = ?1 OR video_id = ?1 LIMIT 1", params![id], |row| Ok(LibraryItemState { liked: row.get::<_, i64>(0)? != 0, youtube_liked: row.get::<_, i64>(1)? != 0, in_library: row.get::<_, i64>(2)? != 0, uploaded: row.get::<_, i64>(3)? != 0, pinned, podcast_saved })).optional().map_err(|e| format!("library item state read failed: {e}"))?;
    Ok(item_state.unwrap_or(LibraryItemState {
        liked: false,
        youtube_liked: false,
        in_library: false,
        uploaded: false,
        pinned,
        podcast_saved,
    }))
}

#[tauri::command]
pub fn speed_dial_toggle(
    item: YtItem,
    pinned: bool,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    if pinned {
        let item_type = match item.kind.as_str() {
            "song" | "episode" => "SONG",
            "album" => "ALBUM",
            "artist" => "ARTIST",
            "playlist" => "PLAYLIST",
            _ => {
                return Err(IpcError::from(format!(
                    "unsupported Speed Dial item kind: {}",
                    item.kind
                )))
            }
        };
        db.execute("INSERT INTO speed_dial (id, secondary_id, title, subtitle, thumbnail, item_type, explicit, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET secondary_id=excluded.secondary_id, title=excluded.title, subtitle=excluded.subtitle, thumbnail=excluded.thumbnail, item_type=excluded.item_type, explicit=excluded.explicit", params![item.id, item.playlist_id, item.title, item.subtitle, item.thumbnail, item_type, if item.explicit { 1 } else { 0 }, now_seconds()]).map_err(|error| format!("Speed Dial pin failed: {error}"))?;
    } else {
        db.execute("DELETE FROM speed_dial WHERE id = ?1", params![item.id])
            .map_err(|error| format!("Speed Dial unpin failed: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn speed_dial_items(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT id, secondary_id, title, COALESCE(subtitle, ''), thumbnail, item_type, explicit FROM speed_dial ORDER BY created_at DESC").map_err(|error| format!("Speed Dial query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let secondary_id: Option<String> = row.get(1)?;
            let item_type: String = row.get(5)?;
            let (kind, video_id, browse_id) = match item_type.as_str() {
                "SONG" => ("song".to_owned(), Some(id.clone()), None),
                "ALBUM" => ("album".to_owned(), None, Some(id.clone())),
                "ARTIST" => ("artist".to_owned(), None, Some(id.clone())),
                _ => ("playlist".to_owned(), None, Some(id.clone())),
            };
            Ok(YtItem {
                id,
                kind,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id,
                playlist_id: secondary_id.clone(),
                video_id,
                set_video_id: None,
                play_playlist_id: secondary_id,
                play_video_id: None,
                params: None,
                explicit: row.get::<_, i64>(6)? != 0,
                music_video_type: None,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|error| format!("Speed Dial rows failed: {error}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Speed Dial row decode failed: {error}"))?)
}

#[tauri::command]
pub fn library_remove_item(id: LibraryId, state: tauri::State<'_, RuntimeState>) -> IpcResult<()> {
    let id = id.into_inner();
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    db.execute("UPDATE songs SET in_library = 0 WHERE id = ?1", params![id])
        .map_err(|e| format!("library remove failed: {e}"))?;
    db.execute("DELETE FROM songs WHERE id = ?1 AND liked = 0 AND youtube_liked = 0 AND uploaded = 0 AND NOT EXISTS (SELECT 1 FROM playlist_songs WHERE song_id = ?1) AND NOT EXISTS (SELECT 1 FROM downloads WHERE downloads.song_id = songs.id)", params![id]).map_err(|e| format!("library cleanup failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn history_add(item: YtItem, state: tauri::State<'_, RuntimeState>) -> IpcResult<i64> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    upsert_played_song(&db, &item, now_seconds())
        .map_err(|error| format!("history song save failed: {error}"))?;
    db.execute(
        "INSERT INTO history (song_id, played_at, play_time_ms) VALUES (?1, ?2, 0)",
        params![item.id, now_seconds()],
    )
    .map_err(|e| format!("history write failed: {e}"))?;
    Ok(db.last_insert_rowid())
}

/// Ensures the songs row and artist mappings for a played song exist, without
/// recording any listening history. Used by the frontend while listen history
/// is paused: `beginPlaytime` calls this instead of `history_add`, so the
/// playback-cache lyrics fill still finds the song and its artists and the
/// song keeps working offline — with no history row and no playtime. The
/// songs upsert is the only fallible step; a failure is reported, never
/// swallowed here (the caller treats it as best-effort).
#[tauri::command]
pub fn library_ensure_played_song(
    item: YtItem,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    upsert_played_song(&db, &item, now_seconds())
        .map_err(|error| format!("played song ensure failed: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn history_record_playtime(
    history_id: i64,
    play_time_ms: i64,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    Ok(record_playtime(&db, history_id, play_time_ms)
        .map_err(|error| format!("history playtime update failed: {error}"))?)
}

#[tauri::command]
pub fn history_clear(state: tauri::State<'_, RuntimeState>) -> IpcResult<()> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    db.execute("DELETE FROM history", [])
        .map_err(|e| format!("history clear failed: {e}"))?;
    db.execute("DELETE FROM songs WHERE liked = 0 AND youtube_liked = 0 AND uploaded = 0 AND in_library = 0 AND NOT EXISTS (SELECT 1 FROM playlist_songs WHERE playlist_songs.song_id = songs.id) AND NOT EXISTS (SELECT 1 FROM downloads WHERE downloads.song_id = songs.id)", []).map_err(|e| format!("history cleanup failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_stats(
    period: Keyword,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<StatsPayload> {
    let period = period.into_inner();
    let period = period.trim().to_lowercase();
    let cutoff = match period.as_str() {
        "day" => now_seconds() - 86_400,
        "week" => now_seconds() - 604_800,
        "month" => now_seconds() - 2_592_000,
        "year" => now_seconds() - 31_536_000,
        "all" => 0,
        _ => return Err(IpcError::from("unsupported stats period".to_owned())),
    };
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let total_plays: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM history WHERE played_at >= ?1",
            params![cutoff],
            |row| row.get(0),
        )
        .map_err(|error| format!("stats total plays query failed: {error}"))?;
    let total_minutes: i64 = listened_minutes(&db, cutoff)
        .map_err(|error| format!("stats total time query failed: {error}"))?;
    let unique_songs: i64 = db
        .query_row(
            "SELECT COUNT(DISTINCT song_id) FROM history WHERE played_at >= ?1",
            params![cutoff],
            |row| row.get(0),
        )
        .map_err(|error| format!("stats unique songs query failed: {error}"))?;
    let mut statement = db.prepare("SELECT s.id, s.kind, s.title, s.subtitle, s.thumbnail, s.browse_id, s.playlist_id, s.video_id, s.set_video_id, s.explicit, s.music_video_type, COUNT(h.id) AS plays, COALESCE(SUM(CASE WHEN h.play_time_ms > 0 THEN h.play_time_ms ELSE MAX(s.duration, 0) * 1000 END), 0) / 60000 AS minutes FROM history h INNER JOIN songs s ON s.id = h.song_id WHERE h.played_at >= ?1 GROUP BY s.id ORDER BY plays DESC, MAX(h.played_at) DESC LIMIT 100").map_err(|error| format!("stats rows query failed: {error}"))?;
    let rows = statement
        .query_map(params![cutoff], |row| {
            Ok(StatsRow {
                item: YtItem {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    title: row.get(2)?,
                    subtitle: row.get(3)?,
                    thumbnail: row.get(4)?,
                    artists: Vec::new(),
                    browse_id: row.get(5)?,
                    playlist_id: row.get(6)?,
                    video_id: row.get(7)?,
                    set_video_id: row.get(8)?,
                    play_playlist_id: None,
                    play_video_id: None,
                    params: None,
                    explicit: row.get::<_, i64>(9)? != 0,
                    music_video_type: row.get(10)?,
                    history_remove_token: None,
                    album_id: None,
                    album_title: None,
                },
                plays: row.get(11)?,
                minutes: row.get(12)?,
            })
        })
        .map_err(|error| format!("stats rows decode failed: {error}"))?;
    let rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("stats rows collect failed: {error}"))?;
    let mut artist_statement = db.prepare("SELECT a.id, a.name, a.thumbnail, COUNT(h.id) AS plays FROM history h INNER JOIN songs s ON s.id = h.song_id INNER JOIN song_artists sa ON sa.song_id = s.id INNER JOIN artists a ON a.id = sa.artist_id WHERE h.played_at >= ?1 GROUP BY a.id, a.name, a.thumbnail ORDER BY plays DESC, MAX(h.played_at) DESC LIMIT 100").map_err(|error| format!("stats artists query failed: {error}"))?;
    let artists = artist_statement
        .query_map(params![cutoff], |row| {
            Ok(StatsGroup {
                id: row.get(0)?,
                title: row.get(1)?,
                subtitle: "Artist".to_owned(),
                thumbnail: row.get(2)?,
                plays: row.get(3)?,
            })
        })
        .map_err(|error| format!("stats artist rows failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("stats artist decode failed: {error}"))?;
    let mut album_statement = db.prepare("SELECT a.id, a.title, a.thumbnail, COUNT(h.id) AS plays FROM history h INNER JOIN songs s ON s.id = h.song_id INNER JOIN song_albums sa ON sa.song_id = s.id INNER JOIN albums a ON a.id = sa.album_id WHERE h.played_at >= ?1 GROUP BY a.id, a.title, a.thumbnail ORDER BY plays DESC, MAX(h.played_at) DESC LIMIT 100").map_err(|error| format!("stats albums query failed: {error}"))?;
    let albums = album_statement
        .query_map(params![cutoff], |row| {
            Ok(StatsGroup {
                id: row.get(0)?,
                title: row.get(1)?,
                subtitle: "Album".to_owned(),
                thumbnail: row.get(2)?,
                plays: row.get(3)?,
            })
        })
        .map_err(|error| format!("stats album rows failed: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("stats album decode failed: {error}"))?;
    Ok(StatsPayload {
        period,
        total_plays,
        total_minutes,
        unique_songs,
        rows,
        artists,
        albums,
    })
}

#[tauri::command]
pub fn history_items(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT s.id, s.kind, s.title, s.subtitle, s.thumbnail, s.browse_id, s.playlist_id, s.video_id, s.set_video_id, s.explicit, s.music_video_type FROM history h INNER JOIN songs s ON s.id = h.song_id ORDER BY h.played_at DESC, h.id DESC LIMIT 200").map_err(|e| format!("history query failed: {e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id: row.get(5)?,
                playlist_id: row.get(6)?,
                video_id: row.get(7)?,
                set_video_id: row.get(8)?,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: row.get::<_, i64>(9)? != 0,
                music_video_type: row.get(10)?,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|e| format!("history rows failed: {e}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("history row decode failed: {e}"))?)
}

#[tauri::command]
pub fn local_files_pick(
    app: tauri::AppHandle,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Vec<LocalItem>> {
    let paths = FileDialog::new()
        .set_title("Import audio files into Soluna")
        .add_filter(
            "Audio",
            &[
                "mp3", "m4a", "m4b", "flac", "ogg", "opus", "wav", "aac", "alac", "aiff",
            ],
        )
        .pick_files()
        .unwrap_or_default();
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let artwork_dir = database_path()
        .parent()
        .map(|value| value.join("artwork"))
        .unwrap_or_else(|| PathBuf::from("artwork"));
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let mut items = Vec::new();
    for path in paths {
        if !path.is_file() {
            continue;
        }
        // The asset protocol scope defaults to Soluna's own app-data folders only (see tauri.conf.json); an
        // imported file can be anywhere on disk (any drive), so it needs an individual grant to be playable.
        let _ = app.asset_protocol_scope().allow_file(&path);
        let Some(item) = local_item_from_path(&path, &artwork_dir) else {
            continue;
        };
        let modified_at = fs::metadata(&path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs() as i64);
        persist_local_item(&db, &item, modified_at)?;
        items.push(item);
    }
    items.sort_by_key(|item| item.title.to_lowercase());
    Ok(items)
}

#[tauri::command]
pub fn library_downloaded_podcasts(
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Vec<LocalItem>> {
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let mut statement = db.prepare("SELECT s.id, s.kind, s.title, s.subtitle, s.thumbnail, s.video_id, s.set_video_id, s.playlist_id, s.explicit, s.music_video_type, s.album_id, d.path FROM downloads d INNER JOIN songs s ON s.id = d.song_id WHERE d.state = 'completed' AND s.kind = 'episode' ORDER BY d.downloaded_at DESC").map_err(|error| format!("downloaded podcast query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let path: String = row.get(11)?;
            Ok(LocalItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id: None,
                playlist_id: row.get(7)?,
                video_id: row.get(5)?,
                set_video_id: row.get(6)?,
                play_playlist_id: row.get(7)?,
                play_video_id: row.get(5)?,
                params: None,
                explicit: row.get::<_, i64>(8)? != 0,
                music_video_type: row.get(9)?,
                history_remove_token: None,
                album_id: row.get(10)?,
                album_title: None,
                local_path: path,
                duration: 0,
            })
        })
        .map_err(|error| format!("downloaded podcast rows failed: {error}"))?;
    let mut items = Vec::new();
    for row in rows {
        let item = row.map_err(|error| format!("downloaded podcast row decode failed: {error}"))?;
        if Path::new(&item.local_path).is_file() {
            items.push(item);
        }
    }
    Ok(items)
}

#[tauri::command]
pub fn library_local_files(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<LocalItem>> {
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let mut statement = db.prepare("SELECT s.id, s.title, s.subtitle, s.thumbnail, s.duration, s.local_path, COALESCE(a.name, '') FROM songs s LEFT JOIN song_artists sa ON sa.song_id = s.id LEFT JOIN artists a ON a.id = sa.artist_id WHERE s.is_local = 1 AND s.local_path IS NOT NULL AND s.in_library = 1 ORDER BY s.title COLLATE NOCASE ASC").map_err(|error| format!("local files query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let artist: String = row.get(6)?;
            let artist_id = (!artist.is_empty()).then(|| {
                format!(
                    "local-artist:{}",
                    Sha1::digest(artist.as_bytes())
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>()
                )
            });
            Ok(LocalItem {
                id,
                kind: "song".to_owned(),
                title: row.get(1)?,
                subtitle: row.get(2)?,
                thumbnail: row.get(3)?,
                artists: if artist.is_empty() {
                    Vec::new()
                } else {
                    vec![Artist {
                        name: artist,
                        id: artist_id,
                    }]
                },
                browse_id: None,
                playlist_id: None,
                video_id: None,
                set_video_id: None,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: false,
                music_video_type: None,
                history_remove_token: None,
                album_id: None,
                album_title: None,
                local_path: row.get(5)?,
                duration: row.get(4)?,
            })
        })
        .map_err(|error| format!("local files rows failed: {error}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("local files row decode failed: {error}"))?)
}

#[tauri::command]
pub fn library_top_songs(
    period: Keyword,
    limit: i64,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Vec<YtItem>> {
    let period = period.into_inner();
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let cutoff = match period.as_str() {
        "day" => now_seconds() - 86_400,
        "week" => now_seconds() - 604_800,
        "month" => now_seconds() - 2_592_000,
        "year" => now_seconds() - 31_536_000,
        _ => 0,
    };
    let capped_limit = clamp_limit(limit);
    let mut statement = db.prepare("SELECT s.id, s.kind, s.title, s.subtitle, s.thumbnail, s.browse_id, s.playlist_id, s.video_id, s.set_video_id, s.explicit, s.music_video_type FROM songs s INNER JOIN history h ON h.song_id = s.id WHERE h.played_at >= ?1 GROUP BY s.id ORDER BY COUNT(h.id) DESC, MAX(h.played_at) DESC LIMIT ?2").map_err(|error| format!("top songs query failed: {error}"))?;
    let rows = statement
        .query_map(params![cutoff, capped_limit], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id: row.get(5)?,
                playlist_id: row.get(6)?,
                video_id: row.get(7)?,
                set_video_id: row.get(8)?,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: row.get::<_, i64>(9)? != 0,
                music_video_type: row.get(10)?,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|error| format!("top songs rows failed: {error}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("top songs row decode failed: {error}"))?)
}

#[tauri::command]
pub fn library_songs(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT id, kind, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, explicit, music_video_type FROM songs WHERE in_library = 1 ORDER BY saved_at DESC").map_err(|e| format!("library query failed: {e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id: row.get(5)?,
                playlist_id: row.get(6)?,
                video_id: row.get(7)?,
                set_video_id: row.get(8)?,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: row.get::<_, i64>(9)? != 0,
                music_video_type: row.get(10)?,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|e| format!("library rows failed: {e}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("library row decode failed: {e}"))?)
}

#[tauri::command]
pub fn library_mix_songs(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    let mut statement = db.prepare("SELECT DISTINCT s.id, s.kind, s.title, s.subtitle, s.thumbnail, s.browse_id, s.playlist_id, s.video_id, s.set_video_id, s.explicit, s.music_video_type FROM songs s LEFT JOIN playlist_songs ps ON ps.song_id = s.id LEFT JOIN playlists p ON p.id = ps.playlist_id WHERE s.in_library = 1 OR p.id IS NOT NULL ORDER BY s.saved_at DESC").map_err(|e| format!("library mix songs query failed: {e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id: row.get(5)?,
                playlist_id: row.get(6)?,
                video_id: row.get(7)?,
                set_video_id: row.get(8)?,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: row.get::<_, i64>(9)? != 0,
                music_video_type: row.get(10)?,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|e| format!("library mix song rows failed: {e}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("library mix song row decode failed: {e}"))?)
}

#[tauri::command]
pub fn library_liked_songs(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT id, kind, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, explicit, music_video_type FROM songs WHERE liked = 1 ORDER BY COALESCE(liked_date, saved_at) DESC").map_err(|e| format!("liked songs query failed: {e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id: row.get(5)?,
                playlist_id: row.get(6)?,
                video_id: row.get(7)?,
                set_video_id: row.get(8)?,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: row.get::<_, i64>(9)? != 0,
                music_video_type: row.get(10)?,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|e| format!("liked songs rows failed: {e}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("liked songs row decode failed: {e}"))?)
}

#[tauri::command]
pub fn library_uploaded_songs(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT id, kind, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, explicit, music_video_type FROM songs WHERE uploaded = 1 ORDER BY saved_at DESC").map_err(|e| format!("uploaded songs query failed: {e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id: row.get(5)?,
                playlist_id: row.get(6)?,
                video_id: row.get(7)?,
                set_video_id: row.get(8)?,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: row.get::<_, i64>(9)? != 0,
                music_video_type: row.get(10)?,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|e| format!("uploaded song rows failed: {e}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("uploaded song row decode failed: {e}"))?)
}

#[tauri::command]
pub fn library_albums(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT a.id, a.title, a.thumbnail, a.playlist_id, COUNT(sa.song_id) FROM albums a INNER JOIN song_albums sa ON sa.album_id = a.id INNER JOIN songs s ON s.id = sa.song_id WHERE s.in_library = 1 GROUP BY a.id, a.title, a.thumbnail, a.playlist_id ORDER BY a.saved_at DESC").map_err(|error| format!("albums query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: "album".to_owned(),
                title: row.get(1)?,
                subtitle: format!("{} songs", row.get::<_, i64>(4)?),
                thumbnail: row.get(2)?,
                artists: Vec::new(),
                browse_id: row.get(0)?,
                playlist_id: row.get(3)?,
                video_id: None,
                set_video_id: None,
                play_playlist_id: row.get(3)?,
                play_video_id: None,
                params: None,
                explicit: false,
                music_video_type: None,
                history_remove_token: None,
                album_id: Some(row.get(0)?),
                album_title: None,
            })
        })
        .map_err(|error| format!("albums rows failed: {error}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("album row decode failed: {error}"))?)
}

#[tauri::command]
pub fn library_artists(state: tauri::State<'_, RuntimeState>) -> IpcResult<Vec<YtItem>> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT a.id, a.name, a.thumbnail, a.channel_id, COUNT(CASE WHEN s.in_library = 1 THEN sa.song_id END) FROM artists a LEFT JOIN song_artists sa ON sa.artist_id = a.id LEFT JOIN songs s ON s.id = sa.song_id WHERE a.bookmarked_at IS NOT NULL OR s.in_library = 1 GROUP BY a.id, a.name, a.thumbnail, a.channel_id ORDER BY a.bookmarked_at DESC, a.saved_at DESC").map_err(|error| format!("artists query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: "artist".to_owned(),
                title: row.get(1)?,
                subtitle: format!("{} songs", row.get::<_, i64>(4)?),
                thumbnail: row.get(2)?,
                artists: Vec::new(),
                browse_id: row.get(0)?,
                playlist_id: None,
                video_id: None,
                set_video_id: None,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: false,
                music_video_type: None,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|error| format!("artists rows failed: {error}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("artist row decode failed: {error}"))?)
}

#[tauri::command]
pub fn library_playlists(
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Vec<LibraryPlaylistItem>> {
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT p.id, p.title, p.subtitle, p.thumbnail, p.kind, p.saved_at, COUNT(ps.song_id) FROM playlists p LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id GROUP BY p.id, p.title, p.subtitle, p.thumbnail, p.kind, p.saved_at ORDER BY p.saved_at DESC").map_err(|e| format!("playlists query failed: {e}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(LibraryPlaylistItem {
                item: YtItem {
                    id: row.get(0)?,
                    kind: row.get(4)?,
                    title: row.get(1)?,
                    subtitle: row.get(2)?,
                    thumbnail: row.get(3)?,
                    artists: Vec::new(),
                    browse_id: Some(row.get(0)?),
                    playlist_id: Some(row.get(0)?),
                    video_id: None,
                    set_video_id: None,
                    play_playlist_id: Some(row.get(0)?),
                    play_video_id: None,
                    params: None,
                    explicit: false,
                    music_video_type: None,
                    history_remove_token: None,
                    album_id: None,
                    album_title: None,
                },
                saved_at: row.get(5)?,
                song_count: row.get(6)?,
            })
        })
        .map_err(|e| format!("playlists rows failed: {e}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("playlist row decode failed: {e}"))?)
}

#[tauri::command]
pub fn library_artist_state(
    artist_id: LibraryId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<bool> {
    let artist_id = artist_id.into_inner();
    let artist_id = artist_id.trim();
    if artist_id.is_empty() {
        return Err(IpcError::from("artist id is empty".to_owned()));
    }
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    Ok(db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artists WHERE id = ?1 AND bookmarked_at IS NOT NULL)",
            params![artist_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("artist bookmark state failed: {error}"))?)
}

#[tauri::command]
pub async fn library_toggle_artist_bookmarked(
    artist_id: LibraryId,
    name: Text,
    thumbnail: Opt<LongText>,
    channel_id: Opt<YtId>,
    bookmarked: bool,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let artist_id = artist_id.into_inner();
    let name = name.into_inner();
    let thumbnail = thumbnail.into_string();
    let channel_id = channel_id.into_string();
    let artist_id = artist_id.trim();
    let name = name.trim();
    if artist_id.is_empty() || name.is_empty() {
        return Err(IpcError::from("artist id or name is empty".to_owned()));
    }
    let channel_id = channel_id
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("UC") && value.len() > 2)
        .map(str::to_owned);
    {
        let db = state
            .db
            .lock()
            .map_err(|_| "database state poisoned".to_owned())?;
        db.execute("INSERT INTO artists (id, name, thumbnail, channel_id, bookmarked_at, podcast_channel, saved_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6) ON CONFLICT(id) DO UPDATE SET name=excluded.name, thumbnail=excluded.thumbnail, channel_id=COALESCE(excluded.channel_id, artists.channel_id), bookmarked_at=excluded.bookmarked_at, saved_at=excluded.saved_at", params![artist_id, name, thumbnail, channel_id, if bookmarked { Some(now_seconds()) } else { None }, now_seconds()]).map_err(|error| format!("artist bookmark save failed: {error}"))?;
    }
    if let Some(channel_id) = channel_id {
        if let Some(session) = auth_session(&state)? {
            let endpoint = if bookmarked {
                "subscription/subscribe"
            } else {
                "subscription/unsubscribe"
            };
            post(endpoint, json!({ "context": context(&session.visitor_data, true, Some(&session.data_sync_id)), "channelIds": [channel_id] }), Some(&session)).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ytm_refresh_saved_podcasts(state: tauri::State<'_, RuntimeState>) -> IpcResult<i64> {
    let ids = {
        let db = state
            .db
            .lock()
            .map_err(|_| "database state poisoned".to_owned())?;
        let mut statement = db.prepare("SELECT id FROM podcasts WHERE bookmarked_at IS NOT NULL ORDER BY bookmarked_at DESC").map_err(|error| format!("saved podcast refresh query failed: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("saved podcast refresh rows failed: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("saved podcast refresh ids failed: {error}"))?
    };
    if ids.is_empty() {
        return Ok(0);
    }
    let Some(session) = auth_session(&state)? else {
        return Ok(0);
    };
    let visitor_data = visitor(&state).await?;
    let mut refreshed = 0i64;
    for id in ids {
        let response = post("browse", json!({ "context": context(&visitor_data, true, Some(&session.data_sync_id)), "browseId": id }), Some(&session)).await?;
        let page = parse_detail(&response, "podcast", Some(&id));
        let serialized = serde_json::to_string(&page)
            .map_err(|error| format!("podcast detail encode failed: {error}"))?;
        let db = state
            .db
            .lock()
            .map_err(|_| "database state poisoned".to_owned())?;
        db.execute("UPDATE podcasts SET title=CASE WHEN ?1 <> '' THEN ?1 ELSE title END, author=CASE WHEN ?2 <> '' THEN ?2 ELSE author END, thumbnail=COALESCE(?3, thumbnail), detail_json=?4, saved_at=?5 WHERE id=?6", params![page.title, page.subtitle, page.thumbnail, serialized, now_seconds(), id]).map_err(|error| format!("podcast detail refresh save failed: {error}"))?;
        refreshed += 1;
    }
    Ok(refreshed)
}

#[tauri::command]
pub async fn ytm_toggle_episode_saved(
    video_id: VideoId,
    saved: bool,
    set_video_id: Opt<YtId>,
    item: Option<YtItem>,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let video_id = video_id.into_inner();
    let set_video_id = set_video_id.into_string();
    let video_id = video_id.trim();
    if video_id.is_empty() {
        return Err(IpcError::from("episode video id is empty".to_owned()));
    }
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    let action = if saved {
        json!({ "action": "ACTION_ADD_VIDEO", "addedVideoId": video_id })
    } else {
        let set_video_id = set_video_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Saved Episode removal requires the source setVideoId".to_owned())?;
        json!({ "action": "ACTION_REMOVE_VIDEO", "setVideoId": set_video_id, "removedVideoId": video_id })
    };
    post("browse/edit_playlist", json!({ "context": context(&session.visitor_data, true, Some(&session.data_sync_id)), "playlistId": "SE", "actions": [action] }), Some(&session)).await?;
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    if saved {
        if let Some(item) = item {
            let is_video = item
                .music_video_type
                .as_deref()
                .is_some_and(|value| value != "MUSIC_VIDEO_TYPE_ATV");
            db.execute(
                "INSERT INTO songs (id, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, kind, saved_at, explicit, music_video_type, liked, liked_date, in_library, is_video, album_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, NULL, 1, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, thumbnail=excluded.thumbnail, browse_id=excluded.browse_id, playlist_id=excluded.playlist_id, video_id=excluded.video_id, set_video_id=excluded.set_video_id, kind=excluded.kind, saved_at=excluded.saved_at, explicit=excluded.explicit, music_video_type=excluded.music_video_type, in_library=1, is_video=excluded.is_video, album_id=excluded.album_id",
                params![item.id, item.title, item.subtitle, item.thumbnail, item.browse_id, Some("SE"), item.video_id, item.set_video_id, item.kind, now_seconds(), if item.explicit { 1 } else { 0 }, item.music_video_type, if is_video { 1 } else { 0 }, item.album_id],
            ).map_err(|error| format!("saved episode state failed: {error}"))?;
        } else {
            db.execute(
                "UPDATE songs SET in_library = 1 WHERE id = ?1 OR video_id = ?1",
                params![video_id],
            )
            .map_err(|error| format!("saved episode state update failed: {error}"))?;
        }
    } else {
        db.execute(
            "UPDATE songs SET in_library = 0 WHERE id = ?1 OR video_id = ?1",
            params![video_id],
        )
        .map_err(|error| format!("saved episode state removal failed: {error}"))?;
        db.execute("DELETE FROM songs WHERE (id = ?1 OR video_id = ?1) AND in_library = 0 AND liked = 0 AND youtube_liked = 0 AND NOT EXISTS (SELECT 1 FROM playlist_songs WHERE playlist_songs.song_id = songs.id) AND NOT EXISTS (SELECT 1 FROM downloads WHERE downloads.song_id = songs.id)", params![video_id]).map_err(|error| format!("saved episode cleanup failed: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn ytm_toggle_podcast_saved(
    podcast_id: YtId,
    saved: bool,
    title: Text,
    author: Opt<Text>,
    thumbnail: Opt<LongText>,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let podcast_id = podcast_id.into_inner();
    let title = title.into_inner();
    let author = author.into_string();
    let thumbnail = thumbnail.into_string();
    let podcast_id = podcast_id.trim();
    let playlist_id = podcast_id.strip_prefix("MPSP").unwrap_or(podcast_id).trim();
    if podcast_id.is_empty() || playlist_id.is_empty() {
        return Err(IpcError::from("podcast playlist id is empty".to_owned()));
    }
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    let endpoint = if saved {
        "like/like"
    } else {
        "like/removelike"
    };
    post(endpoint, json!({ "context": context(&session.visitor_data, true, Some(&session.data_sync_id)), "target": { "playlistId": playlist_id } }), Some(&session)).await?;
    let db = state
        .db
        .lock()
        .map_err(|_| "database state poisoned".to_owned())?;
    db.execute(
        "INSERT INTO podcasts (id, title, author, thumbnail, bookmarked_at, saved_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author, thumbnail=excluded.thumbnail, bookmarked_at=excluded.bookmarked_at, saved_at=excluded.saved_at",
        params![podcast_id, title.trim(), author.as_deref().map(str::trim).filter(|value| !value.is_empty()), thumbnail, if saved { Some(now_seconds()) } else { None }, now_seconds()],
    ).map_err(|error| format!("podcast state save failed: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn ytm_add_to_playlist(
    playlist_id: YtId,
    video_id: VideoId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let playlist_id = playlist_id.into_inner();
    let video_id = video_id.into_inner();
    let playlist_id = playlist_id.trim().trim_start_matches("VL");
    let video_id = video_id.trim();
    if playlist_id.is_empty() || video_id.is_empty() {
        return Err(IpcError::from("playlist or video id is empty".to_owned()));
    }
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    post("browse/edit_playlist", json!({ "context": context(&session.visitor_data, true, Some(&session.data_sync_id)), "playlistId": playlist_id, "actions": [{ "action": "ACTION_ADD_VIDEO", "addedVideoId": video_id }] }), Some(&session)).await?;
    Ok(())
}

#[tauri::command]
pub async fn ytm_remove_from_playlist(
    playlist_id: YtId,
    video_id: VideoId,
    set_video_id: YtId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let playlist_id = playlist_id.into_inner();
    let video_id = video_id.into_inner();
    let set_video_id = set_video_id.into_inner();
    let playlist_id = playlist_id.trim().trim_start_matches("VL");
    let video_id = video_id.trim();
    let set_video_id = set_video_id.trim();
    if playlist_id.is_empty() || video_id.is_empty() || set_video_id.is_empty() {
        return Err(IpcError::from(
            "playlist, video, or setVideoId is empty".to_owned(),
        ));
    }
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    post("browse/edit_playlist", json!({ "context": context(&session.visitor_data, true, Some(&session.data_sync_id)), "playlistId": playlist_id, "actions": [{ "action": "ACTION_REMOVE_VIDEO", "setVideoId": set_video_id, "removedVideoId": video_id }] }), Some(&session)).await?;
    Ok(())
}

#[tauri::command]
pub async fn ytm_create_playlist(
    title: Name,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<YtItem> {
    let title = title.into_inner();
    let title = title.trim();
    if title.is_empty() {
        return Err(IpcError::from("playlist title is empty".to_owned()));
    }
    let session = auth_session(&state)?
        .ok_or_else(|| "Google/YouTube Music account session is not connected".to_owned())?;
    let response = post("playlist/create", json!({ "context": context(&session.visitor_data, true, Some(&session.data_sync_id)), "title": title }), Some(&session)).await?;
    let playlist_id = response
        .get("playlistId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "YouTube Music create playlist returned no playlistId".to_owned())?
        .to_owned();
    let item = YtItem {
        id: playlist_id.clone(),
        kind: "playlist".to_owned(),
        title: title.to_owned(),
        subtitle: "YouTube Music playlist".to_owned(),
        thumbnail: None,
        artists: Vec::new(),
        browse_id: Some(playlist_id.clone()),
        playlist_id: Some(playlist_id.clone()),
        video_id: None,
        set_video_id: None,
        play_playlist_id: Some(playlist_id.clone()),
        play_video_id: None,
        params: None,
        explicit: false,
        music_video_type: None,
        history_remove_token: None,
        album_id: None,
        album_title: None,
    };
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    db.execute("INSERT INTO playlists (id, title, subtitle, thumbnail, kind, saved_at, source) VALUES (?1, ?2, ?3, NULL, 'playlist', ?4, 'youtube') ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, saved_at=excluded.saved_at, source='youtube'", params![playlist_id, title, item.subtitle, now_seconds()]).map_err(|error| format!("YouTube playlist save failed: {error}"))?;
    Ok(item)
}

#[tauri::command]
pub fn library_create_playlist(
    title: Name,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<YtItem> {
    let title = title.into_inner();
    let title = title.trim();
    if title.is_empty() {
        return Err(IpcError::from("playlist title is empty".to_owned()));
    }
    let id = format!("LOCAL_{}", now_millis());
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    db.execute("INSERT INTO playlists (id, title, subtitle, thumbnail, kind, saved_at) VALUES (?1, ?2, 'Local playlist', NULL, 'playlist', ?3)", params![id, title, now_seconds()]).map_err(|e| format!("playlist create failed: {e}"))?;
    Ok(YtItem {
        id: id.clone(),
        kind: "playlist".to_owned(),
        title: title.to_owned(),
        subtitle: "Local playlist".to_owned(),
        thumbnail: None,
        artists: Vec::new(),
        browse_id: Some(id.clone()),
        playlist_id: Some(id.clone()),
        video_id: None,
        set_video_id: None,
        play_playlist_id: Some(id),
        play_video_id: None,
        params: None,
        explicit: false,
        music_video_type: None,
        history_remove_token: None,
        album_id: None,
        album_title: None,
    })
}

#[tauri::command]
pub fn library_add_to_playlist(
    playlist_id: LibraryId,
    item: YtItem,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<bool> {
    let playlist_id = playlist_id.into_inner();
    let playlist_id = playlist_id.trim();
    if playlist_id.is_empty() || item.id.trim().is_empty() {
        return Err(IpcError::from("playlist or item id is empty".to_owned()));
    }
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let already_present: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM playlist_songs WHERE playlist_id = ?1 AND song_id = ?2)",
            params![playlist_id, item.id],
            |row| row.get(0),
        )
        .map_err(|e| format!("playlist duplicate check failed: {e}"))?;
    if already_present {
        return Ok(false);
    }
    db.execute("INSERT INTO songs (id, title, subtitle, thumbnail, browse_id, playlist_id, video_id, set_video_id, kind, saved_at, explicit, music_video_type, in_library, is_video) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13) ON CONFLICT(id) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle, thumbnail=excluded.thumbnail, browse_id=excluded.browse_id, playlist_id=excluded.playlist_id, video_id=excluded.video_id, set_video_id=excluded.set_video_id, kind=excluded.kind, explicit=excluded.explicit, music_video_type=excluded.music_video_type, is_video=excluded.is_video", params![item.id, item.title, item.subtitle, item.thumbnail, item.browse_id, item.playlist_id, item.video_id, item.set_video_id, item.kind, now_seconds(), if item.explicit { 1 } else { 0 }, item.music_video_type, if item.music_video_type.as_deref().is_some_and(|v| v != "MUSIC_VIDEO_TYPE_ATV") { 1 } else { 0 }]).map_err(|e| format!("playlist song save failed: {e}"))?;
    let position: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_songs WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("playlist position failed: {e}"))?;
    db.execute("INSERT OR REPLACE INTO playlist_songs (playlist_id, position, song_id) VALUES (?1, ?2, ?3)", params![playlist_id, position, item.id]).map_err(|e| format!("playlist add failed: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn library_remove_from_playlist(
    playlist_id: LibraryId,
    song_id: LibraryId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<()> {
    let playlist_id = playlist_id.into_inner();
    let song_id = song_id.into_inner();
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    db.execute(
        "DELETE FROM playlist_songs WHERE playlist_id = ?1 AND song_id = ?2",
        params![playlist_id, song_id],
    )
    .map_err(|error| format!("playlist removal failed: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_playlist_songs(
    playlist_id: LibraryId,
    state: tauri::State<'_, RuntimeState>,
) -> IpcResult<Vec<YtItem>> {
    let playlist_id = playlist_id.into_inner();
    let db = state.db.lock().map_err(|_| "database state poisoned")?;
    let mut statement = db.prepare("SELECT s.id, s.kind, s.title, s.subtitle, s.thumbnail, s.browse_id, s.playlist_id, s.video_id, s.set_video_id, s.explicit, s.music_video_type FROM playlist_songs ps INNER JOIN songs s ON s.id = ps.song_id WHERE ps.playlist_id = ?1 ORDER BY ps.position ASC").map_err(|e| format!("playlist songs query failed: {e}"))?;
    let rows = statement
        .query_map(params![playlist_id], |row| {
            Ok(YtItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                subtitle: row.get(3)?,
                thumbnail: row.get(4)?,
                artists: Vec::new(),
                browse_id: row.get(5)?,
                playlist_id: row.get(6)?,
                video_id: row.get(7)?,
                set_video_id: row.get(8)?,
                play_playlist_id: None,
                play_video_id: None,
                params: None,
                explicit: row.get::<_, i64>(9)? != 0,
                music_video_type: row.get(10)?,
                history_remove_token: None,
                album_id: None,
                album_title: None,
            })
        })
        .map_err(|e| format!("playlist songs rows failed: {e}"))?;
    Ok(rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("playlist songs row decode failed: {e}"))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(SCHEMA_SQL).unwrap();
        db
    }

    fn seed_song(db: &Connection, id: &str, title: &str) {
        db.execute(
            "INSERT INTO songs (id, title, subtitle, kind, saved_at, in_library) VALUES (?1, ?2, '', 'song', 1, 1)",
            params![id, title],
        )
        .unwrap();
    }

    fn seed_artist(db: &Connection, id: &str, name: &str) {
        db.execute(
            "INSERT INTO artists (id, name, saved_at) VALUES (?1, ?2, 1)",
            params![id, name],
        )
        .unwrap();
    }

    fn map_artist(db: &Connection, song_id: &str, artist_id: &str, position: i64) {
        db.execute(
            "INSERT INTO song_artists (song_id, artist_id, position) VALUES (?1, ?2, ?3)",
            params![song_id, artist_id, position],
        )
        .unwrap();
    }

    /// (position, artist_id, artist name) for one song, in mapping order.
    fn artist_mappings(db: &Connection, song_id: &str) -> Vec<(i64, String, String)> {
        let mut statement = db
            .prepare(
                "SELECT sa.position, a.id, a.name FROM song_artists sa JOIN artists a ON a.id = sa.artist_id WHERE sa.song_id = ?1 ORDER BY sa.position",
            )
            .unwrap();
        statement
            .query_map(params![song_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn artist_name(db: &Connection, artist_id: &str) -> Option<String> {
        db.query_row(
            "SELECT name FROM artists WHERE id = ?1",
            params![artist_id],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn artist_count(db: &Connection) -> i64 {
        db.query_row("SELECT COUNT(*) FROM artists", [], |row| row.get(0))
            .unwrap()
    }

    fn song_title(db: &Connection, song_id: &str) -> String {
        db.query_row(
            "SELECT title FROM songs WHERE id = ?1",
            params![song_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn song_subtitle(db: &Connection, song_id: &str) -> String {
        db.query_row(
            "SELECT subtitle FROM songs WHERE id = ?1",
            params![song_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn edit_item_renames_only_the_edited_songs_artist() {
        let db = test_db();
        seed_song(&db, "song-a", "Title A");
        seed_song(&db, "song-b", "Title B");
        seed_artist(&db, "artist-shared", "Shared");
        map_artist(&db, "song-a", "artist-shared", 0);
        map_artist(&db, "song-b", "artist-shared", 0);

        assert!(edit_library_item(&db, "song-a", "Title A Edited", "Renamed").is_ok());

        assert_eq!(song_title(&db, "song-a"), "Title A Edited");
        assert_eq!(song_subtitle(&db, "song-a"), "Renamed");
        // The shared artist row itself is untouched, so song B still shows it.
        assert_eq!(artist_name(&db, "artist-shared").as_deref(), Some("Shared"));
        assert_eq!(
            artist_mappings(&db, "song-b"),
            vec![(0, "artist-shared".to_owned(), "Shared".to_owned())]
        );
        assert_eq!(song_title(&db, "song-b"), "Title B");
        // Only song A's mapping moved, to an artist row named "Renamed".
        let mappings = artist_mappings(&db, "song-a");
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].0, 0);
        assert_eq!(mappings[0].2, "Renamed");
        assert_ne!(mappings[0].1, "artist-shared");
    }

    #[test]
    fn edit_item_renames_sole_artist_in_place() {
        let db = test_db();
        seed_song(&db, "song-a", "Title A");
        seed_artist(&db, "artist-solo", "Solo");
        map_artist(&db, "song-a", "artist-solo", 0);

        assert!(edit_library_item(&db, "song-a", "Title A", "Solo Renamed").is_ok());

        // No other song uses this artist, so the row itself is renamed.
        assert_eq!(
            artist_mappings(&db, "song-a"),
            vec![(0, "artist-solo".to_owned(), "Solo Renamed".to_owned())]
        );
        assert_eq!(artist_count(&db), 1);
    }

    #[test]
    fn edit_item_attaches_artist_when_song_has_no_mapping() {
        let db = test_db();
        seed_song(&db, "song-a", "Title A");

        assert!(edit_library_item(&db, "song-a", "Title A", "New Artist").is_ok());

        assert_eq!(song_subtitle(&db, "song-a"), "New Artist");
        let mappings = artist_mappings(&db, "song-a");
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].0, 0);
        assert_eq!(mappings[0].2, "New Artist");
    }

    #[test]
    fn edit_item_reuses_existing_artist_row_with_the_same_name() {
        let db = test_db();
        seed_song(&db, "song-a", "Title A");
        seed_song(&db, "song-b", "Title B");
        seed_artist(&db, "artist-foo", "Foo");
        seed_artist(&db, "artist-bar", "Bar");
        map_artist(&db, "song-a", "artist-foo", 0);
        map_artist(&db, "song-b", "artist-bar", 0);

        assert!(edit_library_item(&db, "song-a", "Title A", "Bar").is_ok());

        // Song A now shares song B's artist row; no duplicate "Bar" row.
        assert_eq!(
            artist_mappings(&db, "song-a"),
            vec![(0, "artist-bar".to_owned(), "Bar".to_owned())]
        );
        assert_eq!(artist_count(&db), 2);
        assert_eq!(artist_name(&db, "artist-foo").as_deref(), Some("Foo"));
        assert_eq!(
            artist_mappings(&db, "song-b"),
            vec![(0, "artist-bar".to_owned(), "Bar".to_owned())]
        );
    }

    #[test]
    fn edit_item_keeps_other_artists_of_a_multi_artist_song() {
        let db = test_db();
        seed_song(&db, "song-a", "Title A");
        seed_song(&db, "song-b", "Title B");
        seed_artist(&db, "artist-shared", "Shared");
        seed_artist(&db, "artist-other", "Other");
        map_artist(&db, "song-a", "artist-shared", 0);
        map_artist(&db, "song-a", "artist-other", 1);
        map_artist(&db, "song-b", "artist-shared", 0);

        assert!(edit_library_item(&db, "song-a", "Title A", "Renamed").is_ok());

        // Only the first mapping moved; the second artist is untouched and
        // keeps its position, and song B still shows "Shared".
        let mappings = artist_mappings(&db, "song-a");
        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[0].0, 0);
        assert_eq!(mappings[0].2, "Renamed");
        assert_ne!(mappings[0].1, "artist-shared");
        assert_eq!(
            mappings[1],
            (1, "artist-other".to_owned(), "Other".to_owned())
        );
        assert_eq!(
            artist_mappings(&db, "song-b"),
            vec![(0, "artist-shared".to_owned(), "Shared".to_owned())]
        );
    }

    #[test]
    fn edit_item_on_missing_song_errors() {
        let db = test_db();
        assert!(edit_library_item(&db, "no-such-song", "Title", "Artist").is_err());
    }

    #[test]
    fn edit_item_renamed_local_artist_row_gets_a_fresh_id() {
        let db = test_db();
        // A local-artist row the old shared-rename bug had renamed: its id
        // still derives from "Foo" but its name is now "Bar", shared by two
        // songs. Editing one song's artist back to "Foo" must not fail on
        // the primary key and must not hijack the renamed row.
        seed_song(&db, "song-a", "Title A");
        seed_song(&db, "song-b", "Title B");
        let renamed_id = local_artist_id("Foo");
        seed_artist(&db, &renamed_id, "Bar");
        map_artist(&db, "song-a", &renamed_id, 0);
        map_artist(&db, "song-b", &renamed_id, 0);

        assert!(edit_library_item(&db, "song-a", "Title A", "Foo").is_ok());

        let mappings = artist_mappings(&db, "song-a");
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].2, "Foo");
        assert_ne!(mappings[0].1, renamed_id);
        assert_eq!(artist_name(&db, &renamed_id).as_deref(), Some("Bar"));
        assert_eq!(
            artist_mappings(&db, "song-b"),
            vec![(0, renamed_id, "Bar".to_owned())]
        );
    }

    #[test]
    fn edit_item_with_empty_artist_keeps_existing_mapping() {
        let db = test_db();
        seed_song(&db, "song-a", "Title A");
        seed_artist(&db, "artist-keep", "Keep");
        map_artist(&db, "song-a", "artist-keep", 0);

        assert!(edit_library_item(&db, "song-a", "Title A Edited", "").is_ok());

        assert_eq!(song_title(&db, "song-a"), "Title A Edited");
        assert_eq!(song_subtitle(&db, "song-a"), "");
        assert_eq!(
            artist_mappings(&db, "song-a"),
            vec![(0, "artist-keep".to_owned(), "Keep".to_owned())]
        );
    }
}
