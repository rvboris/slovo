use std::sync::OnceLock;
use std::time::Duration;

use crate::settings;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;

#[derive(Deserialize)]
struct Response {
    text: String,
}

pub fn correction_url(value: &str) -> Result<url::Url, String> {
    let mut url = url::Url::parse(value.trim())
        .map_err(|_| "Некорректный URL сервера корректировки.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("URL должен быть HTTP(S), без учетных данных, query и fragment.".into());
    }
    let loopback = match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if url.scheme() == "http" && !loopback {
        return Err("Для удаленного сервера корректировки требуется HTTPS.".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/v1/chat/completions") {
        path.to_owned()
    } else if path.ends_with("/v1") {
        format!("{path}/chat/completions")
    } else {
        format!("{path}/v1/chat/completions")
    };
    url.set_path(&path);
    Ok(url)
}

pub fn correction_enabled(settings: &settings::Settings) -> bool {
    settings
        .llm_server_url
        .as_deref()
        .is_some_and(|url| !url.trim().is_empty())
}

pub async fn correct(settings: &settings::Settings, text: &str) -> Result<String, String> {
    correct_with_timeout(settings, text, Duration::from_secs(10)).await
}

async fn correct_with_timeout(
    settings: &settings::Settings,
    text: &str,
    timeout: Duration,
) -> Result<String, String> {
    if text.trim().is_empty() || !correction_enabled(settings) {
        return Ok(text.to_owned());
    }
    let url = correction_url(settings.llm_server_url.as_deref().unwrap_or_default())?;
    let model = settings.llm_model.as_deref().unwrap_or_default().trim();
    let prompt = settings.llm_prompt.as_deref().unwrap_or_default().trim();
    if model.is_empty() || prompt.is_empty() {
        return Err("Укажите модель и непустой промпт.".into());
    }
    let mut request = correction_client()
        .post(url)
        .timeout(timeout)
        .json(&serde_json::json!({
            "model": model,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": text}
            ]
        }));
    if let Some(key) = settings
        .llm_api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
    {
        request = request.bearer_auth(key);
    }
    // Do not expose request URLs, credentials, transcripts, or provider bodies in errors.
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "Сервер не ответил вовремя."
        } else {
            "Ошибка соединения с сервером."
        }
        .to_owned()
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "Сервер вернул HTTP {}.",
            response.status().as_u16()
        ));
    }
    let body: serde_json::Value = response.json().await.map_err(|error| {
        if error.is_timeout() {
            "Сервер не ответил вовремя."
        } else {
            "Некорректный JSON ответа."
        }
        .to_owned()
    })?;
    body.pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Сервер вернул пустой или некорректный текст.".into())
}

static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn shared_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(reqwest::Client::new)
}

fn correction_client() -> &'static reqwest::Client {
    static CORRECTION_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CORRECTION_CLIENT.get_or_init(|| {
        // Redirects must not bypass correction URL transport validation.
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("HTTP client initialization failed")
    })
}

pub async fn check_server(server_url: &str) -> Result<(), String> {
    let url = settings::transcription_url(server_url)?;
    shared_client()
        .get(url)
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map(|_| ())
        .map_err(|error| {
            if error.is_timeout() {
                "Сервер не ответил вовремя.".to_owned()
            } else {
                "Не удалось подключиться к серверу.".to_owned()
            }
        })
}

pub async fn transcribe(server_url: &str, wav: Vec<u8>) -> Result<String, String> {
    transcribe_with_timeout(server_url, wav, Duration::from_mins(2)).await
}

async fn transcribe_with_timeout(
    server_url: &str,
    wav: Vec<u8>,
    timeout: Duration,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&settings::transcription_url(server_url)?)
        .map_err(|_| "Некорректный URL транскрипции.".to_owned())?;
    let deadline = tokio::time::Instant::now() + timeout;
    // Reqwest cannot replay its streaming multipart body for 307/308.
    // Rebuild it for bounded redirects, sharing one deadline across all hops.
    let mut redirects = 0;
    let response = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("Сервер не ответил вовремя.".into());
        }
        let audio = Part::bytes(wav.clone())
            .file_name("recording.wav")
            .mime_str("audio/wav")
            .map_err(|_| "Не удалось подготовить аудио.".to_owned())?;
        let response = shared_client()
            .post(url.clone())
            .timeout(remaining)
            .multipart(Form::new().part("file", audio).text("model", "whisper-1"))
            .send()
            .await
            .map_err(|_| "Не удалось выполнить транскрипцию.".to_owned())?;
        if !matches!(response.status().as_u16(), 307 | 308) || redirects == 10 {
            break response;
        }
        let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
            break response;
        };
        url = location
            .to_str()
            .ok()
            .and_then(|location| response.url().join(location).ok())
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .ok_or_else(|| "Некорректное перенаправление транскрипции.".to_owned())?;
        redirects += 1;
    };
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!("transcription server returned {status}"));
    }
    response
        .json::<Response>()
        .await
        .map(|response| response.text)
        .map_err(|_| "Некорректный ответ сервера транскрипции.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn accept_bounded(listener: &TcpListener) -> std::net::TcpStream {
        listener.set_nonblocking(true).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    return stream;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "request never arrived"
                    );
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept: {error}"),
            }
        }
    }

    fn serve_once(status: u16, body: &'static str) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "request never arrived"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            request
        });
        (url, server)
    }

    #[tokio::test]
    async fn transcription_sends_wav_multipart_and_preserves_text() {
        let (url, server) = serve_once(200, r#"{"text":"  Привет\n"}"#);
        let wav = b"RIFF-test-audio".to_vec();
        assert_eq!(
            transcribe_with_timeout(&url, wav, Duration::from_secs(2))
                .await
                .unwrap(),
            "  Привет\n"
        );
        let request = String::from_utf8(server.join().unwrap()).unwrap();
        assert!(request.starts_with("POST /v1/audio/transcriptions HTTP/1.1\r\n"));
        for required in [
            "multipart/form-data; boundary=",
            "name=\"file\"",
            "audio/wav",
            "RIFF-test-audio",
            "name=\"model\"",
            "whisper-1",
        ] {
            assert!(request.contains(required), "missing {required}");
        }
    }

    #[tokio::test]
    async fn transcription_errors_do_not_echo_provider_body() {
        for (status, body) in [
            (401, "private-token"),
            (200, "private-transcript"),
            (200, r#"{"text":null}"#),
            (200, "{}"),
        ] {
            let (url, server) = serve_once(status, body);
            let error = transcribe_with_timeout(&url, vec![0; 4], Duration::from_secs(2))
                .await
                .unwrap_err();
            assert!(!error.contains(body));
            assert!(!error.contains(&url));
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn reachability_accepts_http_errors_but_rejects_invalid_urls() {
        let (url, server) = serve_once(405, "method not allowed");
        check_server(&url).await.unwrap();
        assert!(server
            .join()
            .unwrap()
            .starts_with(b"GET /v1/audio/transcriptions "));
        assert!(check_server("file:///tmp/server").await.is_err());
    }

    #[tokio::test]
    async fn disabled_or_blank_correction_does_not_validate_or_send() {
        let mut settings = settings::Settings::default();
        assert_eq!(
            correct(&settings, " original ").await.unwrap(),
            " original "
        );
        settings.llm_server_url = Some("not a URL".into());
        assert_eq!(correct(&settings, " \n ").await.unwrap(), " \n ");
        assert!(correct(&settings, "original").await.is_err());
    }

    #[tokio::test]
    async fn redirects_are_allowed_only_for_transcription() {
        for status in [307, 308] {
            for correction in [false, true] {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let address = listener.local_addr().unwrap();
                listener.set_nonblocking(true).unwrap();
                let server = std::thread::spawn(move || {
                    let deadline = std::time::Instant::now() + Duration::from_secs(3);
                    let mut requests = 0;
                    loop {
                        let (mut stream, _) = match listener.accept() {
                            Ok(connection) => connection,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                if std::time::Instant::now() >= deadline {
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(5));
                                continue;
                            }
                            Err(error) => panic!("{error}"),
                        };
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut buffer = [0; 4096];
                        loop {
                            let count = stream.read(&mut buffer).unwrap();
                            assert!(count > 0);
                            request.extend_from_slice(&buffer[..count]);
                            if let Some(end) =
                                request.windows(4).position(|part| part == b"\r\n\r\n")
                            {
                                let headers =
                                    String::from_utf8_lossy(&request[..end]).to_lowercase();
                                let length: usize = headers
                                    .lines()
                                    .find_map(|line| line.strip_prefix("content-length: "))
                                    .unwrap_or("0")
                                    .parse()
                                    .unwrap();
                                if request.len() >= end + 4 + length {
                                    break;
                                }
                            }
                        }
                        requests += 1;
                        if requests == 1 {
                            write!(stream, "HTTP/1.1 {status} Redirect\r\nLocation: http://{address}/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                        } else {
                            assert!(request.starts_with(b"POST /redirected "));
                            let body = r#"{"text":"redirected transcript"}"#;
                            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                            break;
                        }
                    }
                    requests
                });
                if correction {
                    let settings = settings::Settings {
                        llm_server_url: Some(format!("http://{address}")),
                        llm_model: Some("test-model".into()),
                        llm_prompt: Some("fix".into()),
                        ..Default::default()
                    };
                    let error = correct(&settings, "original").await.unwrap_err();
                    assert!(error.contains(&status.to_string()));
                } else {
                    assert_eq!(
                        transcribe_with_timeout(
                            &format!("http://{address}"),
                            vec![0; 16],
                            Duration::from_secs(2)
                        )
                        .await
                        .unwrap(),
                        "redirected transcript"
                    );
                }
                assert_eq!(server.join().unwrap(), if correction { 1 } else { 2 });
            }
        }
    }

    #[tokio::test]
    async fn transcription_timeout_covers_headers_and_body() {
        // Initialize TLS roots before the request deadline; cold initialization can
        // exceed a short timeout before the local server even receives a connection.
        shared_client();
        for send_headers in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let mut stream = accept_bounded(&listener);
                if send_headers {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n").unwrap();
                }
                std::thread::sleep(Duration::from_secs(2));
            });
            let result = tokio::time::timeout(
                Duration::from_millis(1500),
                transcribe_with_timeout(
                    &format!("http://{address}"),
                    vec![0; 16],
                    Duration::from_secs(1),
                ),
            )
            .await
            .expect("transcription must time out before the server closes");
            assert!(result.is_err());
            server.join().unwrap();
        }
    }

    #[test]
    fn correction_transport_security() {
        for host in ["localhost", "LOCALHOST", "127.0.0.1", "127.2.3.4", "[::1]"] {
            assert!(correction_url(&format!("http://{host}:8080/v1")).is_ok());
        }
        for host in [
            "example.com",
            "localhost.example.com",
            "example.localhost",
            "127.0.0.1.example.com",
            "192.168.1.1",
            "[::2]",
        ] {
            assert!(correction_url(&format!("http://{host}/v1")).is_err());
            assert!(correction_url(&format!("https://{host}/v1")).is_ok());
        }
    }

    #[test]
    fn correction_urls() {
        for suffix in ["", "/", "/v1", "/v1/", "/v1/chat/completions/"] {
            assert_eq!(
                correction_url(&format!("https://host{suffix}"))
                    .unwrap()
                    .as_str(),
                "https://host/v1/chat/completions"
            );
        }
        assert_eq!(
            correction_url("https://host/api/v1").unwrap().path(),
            "/api/v1/chat/completions"
        );
        for bad in [
            "localhost:8080",
            "file:///tmp/a",
            "https://u:p@host",
            "https://host?key=secret",
            "https://host/#x",
        ] {
            assert!(correction_url(bad).is_err());
        }
    }

    #[tokio::test]
    async fn correction_http_and_fallback_errors() {
        correction_client();
        for (status, body, delay, expected) in [
            (
                200,
                r#"{"choices":[{"message":{"content":" corrected "}}]}"#,
                0,
                Some("corrected"),
            ),
            (500, "private provider body", 0, None),
            (200, r#"{"choices":[{"message":{"content":" "}}]}"#, 0, None),
            (200, "invalid JSON private body", 0, None),
            (200, "{}", 2000, None),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let mut stream = accept_bounded(&listener);
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse()
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            assert!(headers.starts_with("post /v1/chat/completions "));
                            assert!(headers.contains("authorization: bearer test-key"));
                            let json: serde_json::Value =
                                serde_json::from_slice(&request[end + 4..]).unwrap();
                            assert_eq!(json["model"], "test-model");
                            assert_eq!(json["messages"][0]["content"], "fix");
                            assert_eq!(json["messages"][1]["content"], "original");
                            break;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(delay));
                let _ = write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            });
            let settings = settings::Settings {
                llm_server_url: Some(format!("http://{address}/v1")),
                llm_model: Some("test-model".into()),
                llm_prompt: Some("fix".into()),
                llm_api_key: Some("test-key".into()),
                ..Default::default()
            };
            let result = correct_with_timeout(
                &settings,
                "original",
                Duration::from_secs(if delay > 0 { 1 } else { 2 }),
            )
            .await;
            if let Some(expected) = expected {
                assert_eq!(result.unwrap(), expected);
            } else {
                let error = result.unwrap_err();
                if delay > 0 {
                    assert_eq!(error, "Сервер не ответил вовремя.");
                }
                for secret in ["test-key", "original", "private", "test-model"] {
                    assert!(!error.contains(secret));
                }
            }
            server.join().unwrap();
        }
        let mut settings = settings::Settings::default();
        assert_eq!(correct(&settings, "original").await.unwrap(), "original");
        settings.llm_server_url = Some("http://127.0.0.1:1".into());
        assert!(correct(&settings, "original").await.is_err());
        assert_eq!(correct(&settings, " ").await.unwrap(), " ");
    }
}
