//! The data folder moved from `Meld Desktop` to `Soluna` when the app was renamed. Downloads, the playback cache and
//! imported local artwork are stored by absolute path, so after the folder is renamed those rows must follow it.

use rusqlite::{params, Connection};
use std::path::Path;

/// Columns that hold a file inside the data folder (table, column). Names are fixed here, never user input.
const PATH_COLUMNS: [(&str, &str); 4] = [
    ("downloads", "path"),
    ("downloads", "artwork_path"),
    ("player_cache", "path"),
    ("songs", "thumbnail"),
];

/// Points every stored path that starts with `old_dir` at `new_dir` instead and returns how many values changed.
/// Only the leading folder is replaced, so values that are not inside `old_dir` (web addresses, music in the user's
/// own folders) are left alone. Running it again changes nothing.
pub fn rewrite_data_dir_paths(
    db: &Connection,
    old_dir: &Path,
    new_dir: &Path,
) -> rusqlite::Result<usize> {
    let old = old_dir.to_string_lossy().into_owned();
    let new = new_dir.to_string_lossy().into_owned();
    if old.is_empty() || old == new {
        return Ok(0);
    }
    let mut changed = 0;
    for (table, column) in PATH_COLUMNS {
        // `substr` compares exactly (unlike LIKE, `_` and `%` in a folder name are not wildcards).
        let sql = format!(
            "UPDATE {table} SET {column} = ?2 || substr({column}, length(?1) + 1) \
             WHERE substr({column}, 1, length(?1)) = ?1"
        );
        changed += db.execute(&sql, params![old, new])?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE downloads (song_id TEXT PRIMARY KEY, path TEXT NOT NULL, artwork_path TEXT);
             CREATE TABLE player_cache (song_id TEXT PRIMARY KEY, path TEXT NOT NULL);
             CREATE TABLE songs (id TEXT PRIMARY KEY, thumbnail TEXT);",
        )
        .unwrap();
        db
    }

    fn text(db: &Connection, sql: &str) -> Option<String> {
        db.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn stored_paths_follow_the_renamed_folder() {
        let db = db();
        db.execute_batch(
            r"INSERT INTO downloads VALUES ('a', 'C:\Users\r\AppData\Roaming\Meld Desktop\downloads\a.m4a', 'C:\Users\r\AppData\Roaming\Meld Desktop\downloads\a.jpg');
              INSERT INTO player_cache VALUES ('b', 'C:\Users\r\AppData\Roaming\Meld Desktop\player-cache\b.m4a');
              INSERT INTO songs VALUES ('c', 'C:\Users\r\AppData\Roaming\Meld Desktop\artwork\c.jpg');",
        )
        .unwrap();
        let old = Path::new(r"C:\Users\r\AppData\Roaming\Meld Desktop");
        let new = Path::new(r"C:\Users\r\AppData\Roaming\Soluna");
        assert_eq!(rewrite_data_dir_paths(&db, old, new).unwrap(), 4);
        assert_eq!(
            text(&db, "SELECT path FROM downloads").unwrap(),
            r"C:\Users\r\AppData\Roaming\Soluna\downloads\a.m4a"
        );
        assert_eq!(
            text(&db, "SELECT artwork_path FROM downloads").unwrap(),
            r"C:\Users\r\AppData\Roaming\Soluna\downloads\a.jpg"
        );
        assert_eq!(
            text(&db, "SELECT path FROM player_cache").unwrap(),
            r"C:\Users\r\AppData\Roaming\Soluna\player-cache\b.m4a"
        );
        assert_eq!(
            text(&db, "SELECT thumbnail FROM songs").unwrap(),
            r"C:\Users\r\AppData\Roaming\Soluna\artwork\c.jpg"
        );
    }

    #[test]
    fn it_is_safe_to_run_on_every_start() {
        let db = db();
        db.execute_batch(
            r"INSERT INTO downloads VALUES ('a', 'D:\Meld Desktop\downloads\a.m4a', NULL);",
        )
        .unwrap();
        let (old, new) = (Path::new(r"D:\Meld Desktop"), Path::new(r"D:\Soluna"));
        assert_eq!(rewrite_data_dir_paths(&db, old, new).unwrap(), 1);
        assert_eq!(
            rewrite_data_dir_paths(&db, old, new).unwrap(),
            0,
            "second run changes nothing"
        );
        assert_eq!(
            text(&db, "SELECT path FROM downloads").unwrap(),
            r"D:\Soluna\downloads\a.m4a"
        );
        assert_eq!(
            text(&db, "SELECT artwork_path FROM downloads"),
            None,
            "NULL stays NULL"
        );
    }

    #[test]
    fn values_outside_the_old_folder_are_untouched() {
        let db = db();
        db.execute_batch(
            r"INSERT INTO songs VALUES ('web', 'https://lh3.googleusercontent.com/x');
              INSERT INTO songs VALUES ('own', 'E:\Music\Meld Desktop\cover.jpg');
              INSERT INTO songs VALUES ('near', 'C:\Roaming\Meld Desktop 2\cover.jpg');",
        )
        .unwrap();
        let n = rewrite_data_dir_paths(
            &db,
            Path::new(r"C:\Roaming\Meld Desktop"),
            Path::new(r"C:\Roaming\Soluna"),
        )
        .unwrap();
        assert_eq!(
            n, 1,
            "only the value that starts with the old folder is rewritten"
        );
        assert_eq!(
            text(&db, "SELECT thumbnail FROM songs WHERE id='web'").unwrap(),
            "https://lh3.googleusercontent.com/x"
        );
        assert_eq!(
            text(&db, "SELECT thumbnail FROM songs WHERE id='own'").unwrap(),
            r"E:\Music\Meld Desktop\cover.jpg"
        );
        assert_eq!(
            text(&db, "SELECT thumbnail FROM songs WHERE id='near'").unwrap(),
            r"C:\Roaming\Soluna 2\cover.jpg"
        );
    }

    #[test]
    fn a_folder_name_with_sql_wildcards_is_matched_literally() {
        let db = db();
        db.execute_batch(r"INSERT INTO songs VALUES ('a', 'C:\x_y\f.jpg'); INSERT INTO songs VALUES ('b', 'C:\xzy\f.jpg');")
            .unwrap();
        assert_eq!(
            rewrite_data_dir_paths(&db, Path::new(r"C:\x_y"), Path::new(r"C:\new")).unwrap(),
            1
        );
        assert_eq!(
            text(&db, "SELECT thumbnail FROM songs WHERE id='b'").unwrap(),
            r"C:\xzy\f.jpg"
        );
    }

    #[test]
    fn nothing_happens_when_the_folder_did_not_move() {
        let db = db();
        let dir = Path::new(r"C:\Soluna");
        assert_eq!(rewrite_data_dir_paths(&db, dir, dir).unwrap(), 0);
    }
}
