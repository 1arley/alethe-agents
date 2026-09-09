//! The plugin catalogue.
//!
//! A single JSON index published from the app's own repository, listing plugins
//! that live in their authors' repositories. Nothing is downloaded or executed
//! from here: the catalogue is a directory, and installing still goes through
//! the user importing a folder.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const INDEX_URL: &str = "https://raw.githubusercontent.com/Kc1t/alethe-agents/main/plugins.json";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const CACHE_TTL_SECS: u64 = 6 * 60 * 60;
const SUPPORTED_SCHEMA: u32 = 1;
const MAX_INDEX_BYTES: usize = 512 * 1024;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Alethe/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    /// `owner/name` on GitHub. Shown to the user, never used to build a path.
    #[serde(default)]
    pub repo: String,
    /// Where the user goes to get the plugin. Opened in a browser, never fetched.
    pub download_url: String,
    #[serde(default)]
    pub version: String,
    #[serde(default = "one")]
    pub min_api_version: u32,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    schema: u32,
    #[serde(default)]
    plugins: Vec<CatalogPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub plugins: Vec<CatalogPlugin>,
    pub fetched_at: u64,
    /// True when the network failed and this came from disk.
    #[serde(default)]
    pub stale: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Only `https` links are offered, so a listing cannot point the user's browser
/// at a local file or a scheme handler of its choosing.
fn is_offerable(plugin: &CatalogPlugin, api_version: u32) -> bool {
    !plugin.id.is_empty()
        && plugin
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !plugin.name.is_empty()
        && plugin.download_url.starts_with("https://")
        && plugin.min_api_version <= api_version
}

pub fn parse_index(raw: &str, api_version: u32) -> Result<Vec<CatalogPlugin>, String> {
    let index: Index = serde_json::from_str(raw).map_err(|e| format!("bad_index:{e}"))?;
    if index.schema != SUPPORTED_SCHEMA {
        return Err(format!("unsupported_schema:{}", index.schema));
    }
    Ok(index
        .plugins
        .into_iter()
        .filter(|plugin| is_offerable(plugin, api_version))
        .collect())
}

fn cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(
        crate::paths::profile_data_dir(app)
            .ok()?
            .join("plugins")
            .join("catalog-cache.json"),
    )
}

fn read_cache(app: &tauri::AppHandle) -> Option<CatalogSnapshot> {
    cache_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn write_cache(app: &tauri::AppHandle, snapshot: &CatalogSnapshot) {
    let Some(path) = cache_path(app) else { return };
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(raw) = serde_json::to_string(snapshot) {
        let _ = fs::write(path, raw);
    }
}

#[tauri::command]
pub async fn plugin_catalog(
    app: tauri::AppHandle,
    refresh: Option<bool>,
    api_version: u32,
) -> Result<CatalogSnapshot, String> {
    let cached = read_cache(&app);
    if !refresh.unwrap_or(false) {
        if let Some(snapshot) = cached.as_ref() {
            if now().saturating_sub(snapshot.fetched_at) < CACHE_TTL_SECS {
                return Ok(snapshot.clone());
            }
        }
    }

    let fetched = async {
        let response = client()
            .get(INDEX_URL)
            .send()
            .await
            .map_err(|e| format!("request_failed:{e}"))?;
        if !response.status().is_success() {
            return Err(format!("http_{}", response.status().as_u16()));
        }
        let body = response.text().await.map_err(|e| format!("read_failed:{e}"))?;
        if body.len() > MAX_INDEX_BYTES {
            return Err("index_too_large".to_string());
        }
        parse_index(&body, api_version)
    }
    .await;

    match fetched {
        Ok(plugins) => {
            let snapshot = CatalogSnapshot {
                plugins,
                fetched_at: now(),
                stale: false,
            };
            write_cache(&app, &snapshot);
            Ok(snapshot)
        }
        // A directory the user cannot reach is better served stale than empty.
        Err(error) => match cached {
            Some(snapshot) => Ok(CatalogSnapshot {
                stale: true,
                ..snapshot
            }),
            None => Err(error),
        },
    }
}

/// Opens a catalogue listing in the user's browser. `https` only, and the URL
/// must be one the catalogue actually offered — a listing must not be able to
/// turn this into a general "run anything" opener.
#[tauri::command]
pub async fn plugin_catalog_open(
    app: tauri::AppHandle,
    api_version: u32,
    url: String,
) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("unsupported_url".to_string());
    }
    let snapshot = read_cache(&app).ok_or_else(|| "catalog_unavailable".to_string())?;
    let offered = snapshot
        .plugins
        .iter()
        .any(|plugin| plugin.download_url == url && plugin.min_api_version <= api_version);
    if !offered {
        return Err("url_not_in_catalog".to_string());
    }

    // No shell in the chain: `rundll32` and `open`/`xdg-open` take the URL as a
    // single argument, so a link cannot smuggle a command separator through.
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();

    result.map(|_| ()).map_err(|e| format!("open_failed:{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(entries: &str) -> String {
        format!(r#"{{ "schema": 1, "plugins": [{entries}] }}"#)
    }

    const GOOD: &str = r#"{
        "id": "acme.panel", "name": "Panel",
        "downloadUrl": "https://github.com/acme/panel/releases/latest"
    }"#;

    #[test]
    fn keeps_a_well_formed_entry_and_defaults_the_api_version() {
        let plugins = parse_index(&index(GOOD), 1).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].min_api_version, 1);
    }

    #[test]
    fn refuses_an_index_written_for_another_schema() {
        let raw = r#"{ "schema": 2, "plugins": [] }"#;
        assert_eq!(parse_index(raw, 1).unwrap_err(), "unsupported_schema:2");
    }

    #[test]
    fn drops_entries_this_app_version_cannot_run() {
        let entry = r#"{
            "id": "acme.future", "name": "Future",
            "downloadUrl": "https://example.com/x", "minApiVersion": 2
        }"#;
        assert!(parse_index(&index(entry), 1).unwrap().is_empty());
        assert_eq!(parse_index(&index(entry), 2).unwrap().len(), 1);
    }

    #[test]
    fn drops_a_link_that_is_not_https() {
        for url in [
            "file:///C:/Windows/System32",
            "http://example.com/x",
            "javascript:alert(1)",
            "alethe-plugin://localhost/x",
        ] {
            let entry = format!(r#"{{ "id": "a.b", "name": "N", "downloadUrl": "{url}" }}"#);
            assert!(parse_index(&index(&entry), 1).unwrap().is_empty(), "{url}");
        }
    }

    #[test]
    fn drops_a_forged_id_or_a_missing_name() {
        for entry in [
            r#"{ "id": "../evil", "name": "N", "downloadUrl": "https://a/b" }"#,
            r#"{ "id": "a/b", "name": "N", "downloadUrl": "https://a/b" }"#,
            r#"{ "id": "a.b", "name": "", "downloadUrl": "https://a/b" }"#,
        ] {
            assert!(parse_index(&index(entry), 1).unwrap().is_empty(), "{entry}");
        }
    }

    #[test]
    fn a_malformed_index_is_an_error_not_an_empty_list() {
        assert!(parse_index("not json", 1).is_err());
    }
}
