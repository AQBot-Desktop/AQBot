use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::Path;
use std::ptr;

use libsqlite3_sys as sqlite;

use crate::error::{AQBotError, Result};

pub(super) fn read_documents_root_override(path: &Path) -> Result<Option<String>> {
    let database = SqliteDatabase::open(path, OpenMode::ReadOnly)?;
    if !database.table_exists("settings")? {
        return Ok(None);
    }
    database.query_optional_text(
        "SELECT value FROM settings WHERE key = 'documents_root_override' LIMIT 1",
    )
}

pub(super) fn finalize_restored_database(
    path: &Path,
    documents_root_override: Option<&str>,
) -> Result<()> {
    let database = SqliteDatabase::open(path, OpenMode::ReadWrite)?;
    let has_settings = database.table_exists("settings")?;
    if documents_root_override.is_some() && !has_settings {
        return Err(AQBotError::Validation(
            "Restored database cannot persist its documents root because settings is missing"
                .to_string(),
        ));
    }

    if has_settings {
        database.exec("BEGIN IMMEDIATE")?;
        let update = match documents_root_override {
            Some(value) => database.execute_with_text(
                "INSERT INTO settings (key, value) VALUES ('documents_root_override', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                value,
            ),
            None => database.exec("DELETE FROM settings WHERE key = 'documents_root_override'"),
        };
        if let Err(primary) = update {
            let rollback = database.exec("ROLLBACK");
            return match rollback {
                Ok(()) => Err(primary),
                Err(rollback) => Err(AQBotError::Gateway(format!(
                    "Failed to update restored documents root: {primary}; SQLite rollback failed: {rollback}"
                ))),
            };
        }
        database.exec("COMMIT")?;
    }

    database.quick_check()
}

#[cfg(test)]
pub(super) fn create_test_database(
    path: &Path,
    marker: &str,
    documents_root_override: Option<&str>,
) -> Result<()> {
    let database = SqliteDatabase::open(path, OpenMode::Create)?;
    database.exec(
        "PRAGMA journal_mode = DELETE; \
         PRAGMA page_size = 4096; \
         CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL); \
         CREATE TABLE restore_fixture (value TEXT NOT NULL); \
         CREATE TABLE damage_fixture (value BLOB NOT NULL); \
         INSERT INTO damage_fixture(value) VALUES (zeroblob(20000));",
    )?;
    database.execute_with_text("INSERT INTO restore_fixture(value) VALUES (?1)", marker)?;
    if let Some(value) = documents_root_override {
        database.execute_with_text(
            "INSERT INTO settings(key, value) VALUES ('documents_root_override', ?1)",
            value,
        )?;
    }
    database.quick_check()
}

#[cfg(test)]
pub(super) fn read_test_marker(path: &Path) -> Result<Option<String>> {
    SqliteDatabase::open(path, OpenMode::ReadOnly)?
        .query_optional_text("SELECT value FROM restore_fixture LIMIT 1")
}

#[cfg(test)]
pub(super) fn update_test_marker(path: &Path, marker: &str) -> Result<()> {
    SqliteDatabase::open(path, OpenMode::ReadWrite)?
        .execute_with_text("UPDATE restore_fixture SET value = ?1", marker)
}

enum OpenMode {
    ReadOnly,
    ReadWrite,
    #[cfg(test)]
    Create,
}

struct SqliteDatabase {
    raw: *mut sqlite::sqlite3,
}

impl SqliteDatabase {
    fn open(path: &Path, mode: OpenMode) -> Result<Self> {
        let path = path.to_str().ok_or_else(|| {
            AQBotError::Validation(format!(
                "Pending restore database path is not valid UTF-8: {}",
                path.display()
            ))
        })?;
        let path = CString::new(path).map_err(|_| {
            AQBotError::Validation("Pending restore database path contains NUL".to_string())
        })?;
        let flags = match mode {
            OpenMode::ReadOnly => sqlite::SQLITE_OPEN_READONLY,
            OpenMode::ReadWrite => sqlite::SQLITE_OPEN_READWRITE,
            #[cfg(test)]
            OpenMode::Create => sqlite::SQLITE_OPEN_READWRITE | sqlite::SQLITE_OPEN_CREATE,
        };
        let mut raw = ptr::null_mut();
        let rc = unsafe { sqlite::sqlite3_open_v2(path.as_ptr(), &mut raw, flags, ptr::null()) };
        if rc != sqlite::SQLITE_OK {
            let error = sqlite_error(raw, "open pending restore database");
            if !raw.is_null() {
                unsafe { sqlite::sqlite3_close(raw) };
            }
            return Err(error);
        }
        unsafe {
            sqlite::sqlite3_extended_result_codes(raw, 1);
            sqlite::sqlite3_busy_timeout(raw, 5_000);
        }
        Ok(Self { raw })
    }

    fn table_exists(&self, table: &str) -> Result<bool> {
        let mut statement =
            self.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1")?;
        statement.bind_text(1, table)?;
        statement.step_row()
    }

    fn query_optional_text(&self, sql: &str) -> Result<Option<String>> {
        let mut statement = self.prepare(sql)?;
        if !statement.step_row()? {
            return Ok(None);
        }
        statement.column_text(0)
    }

    fn execute_with_text(&self, sql: &str, value: &str) -> Result<()> {
        let mut statement = self.prepare(sql)?;
        statement.bind_text(1, value)?;
        statement.step_done()
    }

    fn quick_check(&self) -> Result<()> {
        let mut statement = self.prepare("PRAGMA quick_check(1)")?;
        if !statement.step_row()? {
            return Err(AQBotError::Validation(
                "Restored database quick_check returned no result".to_string(),
            ));
        }
        let result = statement.column_text(0)?.unwrap_or_default();
        if result != "ok" {
            return Err(AQBotError::Validation(format!(
                "Restored database quick_check failed: {result}"
            )));
        }
        if statement.step_row()? {
            return Err(AQBotError::Validation(
                "Restored database quick_check returned unexpected extra rows".to_string(),
            ));
        }
        Ok(())
    }

    fn exec(&self, sql: &str) -> Result<()> {
        let sql = CString::new(sql)
            .map_err(|_| AQBotError::Validation("Pending restore SQL contains NUL".to_string()))?;
        let mut error: *mut c_char = ptr::null_mut();
        let rc = unsafe {
            sqlite::sqlite3_exec(self.raw, sql.as_ptr(), None, ptr::null_mut(), &mut error)
        };
        if rc == sqlite::SQLITE_OK {
            return Ok(());
        }
        let message = if error.is_null() {
            sqlite_message(self.raw)
        } else {
            let message = unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned();
            unsafe { sqlite::sqlite3_free(error.cast()) };
            message
        };
        Err(AQBotError::Gateway(format!(
            "Pending restore SQLite command failed: {message}"
        )))
    }

    fn prepare(&self, sql: &str) -> Result<SqliteStatement<'_>> {
        let sql = CString::new(sql)
            .map_err(|_| AQBotError::Validation("Pending restore SQL contains NUL".to_string()))?;
        let mut raw = ptr::null_mut();
        let rc = unsafe {
            sqlite::sqlite3_prepare_v2(self.raw, sql.as_ptr(), -1, &mut raw, ptr::null_mut())
        };
        if rc == sqlite::SQLITE_OK {
            Ok(SqliteStatement {
                database: self,
                raw,
            })
        } else {
            Err(sqlite_error(self.raw, "prepare pending restore statement"))
        }
    }
}

impl Drop for SqliteDatabase {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { sqlite::sqlite3_close(self.raw) };
        }
    }
}

struct SqliteStatement<'a> {
    database: &'a SqliteDatabase,
    raw: *mut sqlite::sqlite3_stmt,
}

impl SqliteStatement<'_> {
    fn bind_text(&mut self, index: c_int, value: &str) -> Result<()> {
        let value = CString::new(value).map_err(|_| {
            AQBotError::Validation("Pending restore SQLite value contains NUL".to_string())
        })?;
        let rc = unsafe {
            sqlite::sqlite3_bind_text(
                self.raw,
                index,
                value.as_ptr(),
                -1,
                sqlite::SQLITE_TRANSIENT(),
            )
        };
        if rc == sqlite::SQLITE_OK {
            Ok(())
        } else {
            Err(sqlite_error(
                self.database.raw,
                "bind pending restore statement",
            ))
        }
    }

    fn step_row(&mut self) -> Result<bool> {
        match unsafe { sqlite::sqlite3_step(self.raw) } {
            sqlite::SQLITE_ROW => Ok(true),
            sqlite::SQLITE_DONE => Ok(false),
            _ => Err(sqlite_error(
                self.database.raw,
                "read pending restore statement",
            )),
        }
    }

    fn step_done(&mut self) -> Result<()> {
        match unsafe { sqlite::sqlite3_step(self.raw) } {
            sqlite::SQLITE_DONE => Ok(()),
            _ => Err(sqlite_error(
                self.database.raw,
                "execute pending restore statement",
            )),
        }
    }

    fn column_text(&self, index: c_int) -> Result<Option<String>> {
        let text = unsafe { sqlite::sqlite3_column_text(self.raw, index) };
        if text.is_null() {
            return Ok(None);
        }
        let size = unsafe { sqlite::sqlite3_column_bytes(self.raw, index) };
        let bytes = unsafe { std::slice::from_raw_parts(text, size.max(0) as usize) };
        String::from_utf8(bytes.to_vec())
            .map(Some)
            .map_err(|error| {
                AQBotError::Validation(format!(
                    "Pending restore SQLite text is not valid UTF-8: {error}"
                ))
            })
    }
}

impl Drop for SqliteStatement<'_> {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { sqlite::sqlite3_finalize(self.raw) };
        }
    }
}

fn sqlite_error(raw: *mut sqlite::sqlite3, context: &str) -> AQBotError {
    AQBotError::Gateway(format!("{context}: {}", sqlite_message(raw)))
}

fn sqlite_message(raw: *mut sqlite::sqlite3) -> String {
    if raw.is_null() {
        return "unknown SQLite error".to_string();
    }
    unsafe { CStr::from_ptr(sqlite::sqlite3_errmsg(raw)) }
        .to_string_lossy()
        .into_owned()
}
