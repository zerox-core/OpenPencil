//! Mock 页面的局域网分享服务：一个极简的静态文件服务器。
//!
//! `mock_share_publish` 把当前项目（预览用的单文件 HTML + 原始项目文件）
//! 放进内存并在 0.0.0.0 上随机端口起一个线程化的 HTTP 服务，返回局域网
//! 地址；`mock_share_stop` 停止服务。公网分享需要额外的隧道，不在本层实现。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::command;

#[derive(serde::Deserialize)]
pub struct ShareFile {
    pub path: String,
    pub content: String,
}

#[derive(serde::Serialize)]
pub struct ShareInfo {
    pub url: String,
    pub port: u16,
}

struct ShareServer {
    stop: Arc<AtomicBool>,
    port: u16,
}

static SHARE_SERVER: Mutex<Option<ShareServer>> = Mutex::new(None);

fn content_type(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".ico") {
        "image/x-icon"
    } else if lower.ends_with(".woff") {
        "font/woff"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".txt") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

fn normalize_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_start_matches('/').replace('\\', "/");
    if trimmed.split('/').any(|segment| segment == "..") {
        return String::new();
    }
    trimmed
}

fn respond(mut stream: TcpStream, status: &str, ctype: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        status,
        ctype,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle_connection(mut stream: TcpStream, files: &HashMap<String, String>, entry: &str) {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut buffer = [0u8; 8192];
    let mut request = String::new();
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                request.push_str(&String::from_utf8_lossy(&buffer[..n]));
                if request.contains("\r\n\r\n") || request.len() > 16384 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let first_line = request.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    if method != "GET" {
        respond(
            stream,
            "405 Method Not Allowed",
            "text/plain; charset=utf-8",
            "Method not allowed",
        );
        return;
    }
    let path = normalize_path(target.split('?').next().unwrap_or(""));
    let key = if path.is_empty() { entry.to_string() } else { path };
    match files.get(&key) {
        Some(body) => respond(stream, "200 OK", content_type(&key), body),
        None => respond(
            stream,
            "404 Not Found",
            "text/plain; charset=utf-8",
            "Not found",
        ),
    }
}

fn is_lan_ipv4(text: &str) -> bool {
    // 仅认 RFC1918 私网地址：10.x / 172.16-31.x / 192.168.x。
    // 198.18.0.0/15 是代理 TUN 虚拟网卡的常用段，100.64/10 是 Tailscale
    // 之类的 CGNAT 段，都不适合当局域网分享地址，全部排除。
    let octets: Vec<Option<u32>> = text
        .split('.')
        .map(|part| part.parse::<u32>().ok())
        .collect();
    if octets.len() != 4 || octets.iter().any(|o| o.is_none()) {
        return false;
    }
    let o: Vec<u32> = octets.into_iter().map(|o| o.unwrap()).collect();
    if o[0] == 10 {
        return true;
    }
    if o[0] == 192 && o[1] == 168 {
        return true;
    }
    if o[0] == 172 && (16..=31).contains(&o[1]) {
        return true;
    }
    false
}

fn collect_ipv4_addresses(line: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in line.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            current.push(ch);
        } else {
            if !current.is_empty() {
                let parts = current.split('.').count();
                if parts == 4 && current.split('.').all(|p| !p.is_empty() && p.len() <= 3) {
                    out.push(current.clone());
                }
                current.clear();
            }
        }
    }
    if !current.is_empty() {
        let parts = current.split('.').count();
        if parts == 4 && current.split('.').all(|p| !p.is_empty() && p.len() <= 3) {
            out.push(current.clone());
        }
    }
    out
}

#[cfg(windows)]
fn lan_ip_from_ipconfig() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let output = Command::new("ipconfig")
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // 只看含 "IPv4" 的行（中文系统是「IPv4 地址」，英文是 "IPv4 Address"），
    // 避免把子网掩码（255.x）或默认网关误当成主机地址。
    for line in text.lines() {
        if line.contains("IPv4") {
            for candidate in collect_ipv4_addresses(line) {
                if is_lan_ipv4(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn lan_ip_from_ipconfig() -> Option<String> {
    None
}

fn lan_ip() -> String {
    // 优先从 ipconfig 找真实的局域网 IPv4；机器开着代理 TUN 时，
    // 下面的 UDP 出口地址会是 TUN 虚拟网卡（如 198.18.0.1），手机访问不到。
    if let Some(ip) = lan_ip_from_ipconfig() {
        return ip;
    }
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                let ip = addr.ip().to_string();
                if is_lan_ipv4(&ip) {
                    return ip;
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

fn stop_server(existing: ShareServer) {
    existing.stop.store(true, Ordering::SeqCst);
    let _ = TcpStream::connect(("127.0.0.1", existing.port));
}

#[command]
pub fn mock_share_publish(files: Vec<ShareFile>, entry: String) -> Result<ShareInfo, String> {
    let mut guard = SHARE_SERVER.lock().map_err(|error| error.to_string())?;
    if let Some(existing) = guard.take() {
        stop_server(existing);
    }
    if files.is_empty() {
        return Err("no files to share".into());
    }
    let entry = if entry.is_empty() {
        "index.html".to_string()
    } else {
        normalize_path(&entry)
    };
    let mut map: HashMap<String, String> = HashMap::new();
    for file in files {
        let path = normalize_path(&file.path);
        if !path.is_empty() {
            map.insert(path, file.content);
        }
    }
    if !map.contains_key(&entry) {
        return Err("entry file missing".into());
    }
    let listener = TcpListener::bind(("0.0.0.0", 0)).map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_loop = stop.clone();
    thread::spawn(move || {
        for connection in listener.incoming() {
            if stop_for_loop.load(Ordering::SeqCst) {
                break;
            }
            match connection {
                Ok(stream) => {
                    let files = map.clone();
                    let entry = entry.clone();
                    thread::spawn(move || handle_connection(stream, &files, &entry));
                }
                Err(_) => continue,
            }
        }
    });
    let url = format!("http://{}:{}/", lan_ip(), port);
    *guard = Some(ShareServer { stop, port });
    Ok(ShareInfo { url, port })
}

#[command]
pub fn mock_share_stop() -> Result<(), String> {
    let mut guard = SHARE_SERVER.lock().map_err(|error| error.to_string())?;
    if let Some(existing) = guard.take() {
        stop_server(existing);
    }
    Ok(())
}
