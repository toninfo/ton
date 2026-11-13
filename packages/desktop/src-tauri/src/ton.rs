//! Running `ton assistant ...`. The desktop shell never touches state.db; every read and write goes
//! through this child process, with fixed arguments (no shell).

use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Clone, Debug)]
pub struct Ton {
    program: PathBuf,
    /// `node <cli.js>` in development.
    prefix: Vec<OsString>,
}

#[derive(Debug)]
pub struct TonOutput {
    pub code: i32,
    /// The single JSON line printed with `--json`.
    pub json: Option<Value>,
    pub stderr: String,
}

#[derive(Debug)]
pub enum TonError {
    Spawn(String),
    Timeout(Duration),
}

impl std::fmt::Display for TonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TonError::Spawn(message) => write!(f, "无法启动 ton：{message}"),
            TonError::Timeout(limit) => write!(f, "ton 超时（{} 秒）", limit.as_secs()),
        }
    }
}

fn is_script(path: &Path) -> bool {
    matches!(path.extension().and_then(|ext| ext.to_str()), Some("js" | "mjs" | "cjs" | "ts"))
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |file| dir.join(file)))
        .find(|candidate| candidate.is_file())
}

/// A built checkout of this repository above `start`, for running the CLI without installing it.
fn find_repo_cli(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .map(|dir| dir.join("packages/coding-agent/dist/cli.js"))
        .find(|candidate| candidate.is_file())
}

impl Ton {
    /// `$TON_BIN` → `ton` on PATH → `node <repo>/packages/coding-agent/dist/cli.js`.
    pub fn discover() -> Option<Ton> {
        if let Some(bin) = std::env::var_os("TON_BIN").filter(|value| !value.is_empty()) {
            return Some(Ton::from_path(PathBuf::from(bin)));
        }
        if let Some(bin) = find_in_path("ton") {
            return Some(Ton { program: bin, prefix: Vec::new() });
        }
        let roots = [std::env::current_exe().ok(), std::env::current_dir().ok()];
        let script = roots.iter().flatten().find_map(|root| find_repo_cli(root))?;
        Some(Ton::from_path(script))
    }

    fn from_path(path: PathBuf) -> Ton {
        if is_script(&path) {
            let node = find_in_path("node").unwrap_or_else(|| PathBuf::from("node"));
            Ton { program: node, prefix: vec![path.into_os_string()] }
        } else {
            Ton { program: path, prefix: Vec::new() }
        }
    }

    pub fn describe(&self) -> String {
        let mut parts = vec![self.program.display().to_string()];
        parts.extend(self.prefix.iter().map(|part| part.to_string_lossy().into_owned()));
        parts.join(" ")
    }

    /// `ton assistant <args...>`; JSON is parsed from the last non-empty stdout line.
    pub async fn assistant(&self, args: &[String], limit: Duration) -> Result<TonOutput, TonError> {
        let mut command = Command::new(&self.program);
        command
            .args(&self.prefix)
            .arg("assistant")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| TonError::Spawn(error.to_string()))?;
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let run = async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let (_, _, status) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err), child.wait());
            (out, err, status)
        };
        let (out, err, status) = tokio::time::timeout(limit, run).await.map_err(|_| TonError::Timeout(limit))?;
        let status = status.map_err(|error| TonError::Spawn(error.to_string()))?;
        let stdout = String::from_utf8_lossy(&out);
        let json = stdout
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .and_then(|line| serde_json::from_str::<Value>(line.trim()).ok());
        Ok(TonOutput {
            code: status.code().unwrap_or(1),
            json,
            stderr: String::from_utf8_lossy(&err).trim().to_string(),
        })
    }
}

/// Subcommands the windows may run. Everything else (settings edits, MCP) stays in the terminal.
pub const ALLOWED: &[&str] = &["inbox", "ack", "act", "status", "pause", "resume", "runs", "trace", "stats", "prefs"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_run_through_node() {
        let ton = Ton::from_path(PathBuf::from("/repo/packages/coding-agent/dist/cli.js"));
        assert_eq!(ton.prefix.len(), 1);
        assert!(ton.describe().ends_with("cli.js"));
        let bin = Ton::from_path(PathBuf::from("/usr/local/bin/ton"));
        assert!(bin.prefix.is_empty());
    }

    #[test]
    fn finds_repo_cli_from_target_dir() {
        let repo = std::env::temp_dir().join(format!("ton-desktop-test-{}", std::process::id()));
        let dist = repo.join("packages/coding-agent/dist");
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(dist.join("cli.js"), "").unwrap();
        let nested = repo.join("packages/desktop/src-tauri/target/debug");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(find_repo_cli(&nested), Some(dist.join("cli.js")));
        std::fs::remove_dir_all(&repo).unwrap();
    }
}
