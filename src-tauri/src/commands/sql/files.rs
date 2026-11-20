use crate::CmdResult;

// SQL files are chosen explicitly using the native open/save dialog.
#[tauri::command]
pub(crate) fn read_sql_file(path: String) -> CmdResult<String> {
    read_text_file(path, "SQL file is larger than 5 MiB")
}

#[tauri::command]
pub(crate) fn read_table_file(path: String) -> CmdResult<String> {
    read_text_file(path, "Import file is larger than 5 MiB")
}

fn read_text_file(path: String, too_large: &str) -> CmdResult<String> {
    use std::io::Read;
    const LIMIT: usize = 5 * 1024 * 1024;
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > LIMIT as u64 {
        return Err(too_large.into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT {
        return Err(too_large.into());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn write_sql_file(path: String, contents: String) -> CmdResult<()> {
    use std::io::Write;
    let path = std::path::Path::new(&path);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let temporary = parent.join(format!(".dbdock-sql-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        if let Ok(meta) = std::fs::metadata(path) {
            file.set_permissions(meta.permissions())?;
        }
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_file_roundtrip_and_reject_large_file() {
        let dir = std::env::temp_dir().join(format!("dbdock-sql-file-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("query.sql");
        let name = path.to_str().unwrap().to_string();
        let sql = "SELECT '日本語';\nSELECT 2;";
        write_sql_file(name.clone(), sql.into()).unwrap();
        assert_eq!(read_sql_file(name.clone()).unwrap(), sql);
        std::fs::write(&path, vec![b'x'; 5 * 1024 * 1024 + 1]).unwrap();
        assert!(read_sql_file(name).unwrap_err().contains("5 MiB"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
