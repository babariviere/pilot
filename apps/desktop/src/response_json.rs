//! Streaming JSON mechanics only. Features own limits and user-facing failures.

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    Oversized,
    Interrupted,
    Malformed,
}

pub(crate) async fn read(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<serde_json::Value, Failure> {
    if response.content_length().is_some_and(|n| n > cap as u64) {
        return Err(Failure::Oversized);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Interrupted)? {
        if bytes.len().saturating_add(chunk.len()) > cap {
            return Err(Failure::Oversized);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn exact_limits_chunked_bodies_and_failure_categories() {
        for (headers, body, cap, expected) in [
            ("Content-Length: 4", "null", 4, Ok(serde_json::Value::Null)),
            ("Content-Length: 4", "null", 3, Err(Failure::Oversized)),
            (
                "Transfer-Encoding: chunked",
                "2\r\nnu\r\n2\r\nll\r\n0\r\n\r\n",
                4,
                Ok(serde_json::Value::Null),
            ),
            (
                "Transfer-Encoding: chunked",
                "2\r\nnu\r\n2\r\nll\r\n0\r\n\r\n",
                3,
                Err(Failure::Oversized),
            ),
            ("Content-Length: 0", "", 0, Err(Failure::Malformed)),
            ("Content-Length: 1", "{", 1, Err(Failure::Malformed)),
            ("Content-Length: 4", "nu", 4, Err(Failure::Interrupted)),
        ] {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap();
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let (response, ()) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                tokio::join!(client.get(url).send(), async {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut request = [0; 4096];
                    let mut header_bytes = 0;
                    while !request[..header_bytes].windows(4).any(|w| w == b"\r\n\r\n") {
                        assert!(
                            header_bytes < request.len(),
                            "synthetic request headers too large"
                        );
                        let n = socket.read(&mut request[header_bytes..]).await.unwrap();
                        assert!(n > 0, "synthetic request headers interrupted");
                        header_bytes += n;
                    }
                    socket
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\n{headers}\r\nConnection: close\r\n\r\n{body}"
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                })
            })
            .await
            .expect("synthetic client/server exchange timed out");
            assert_eq!(
                read(response.unwrap(), cap).await,
                expected,
                "{headers}, cap {cap}"
            );
        }
    }
}
