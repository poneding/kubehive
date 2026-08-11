use tokio::io::{AsyncRead, AsyncReadExt};

pub const MAX_REMOTE_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

pub async fn read_limited<R>(reader: &mut R, description: &str) -> Result<Vec<u8>, String>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("Unable to read {description}: {error}"))?;
        if read == 0 {
            return Ok(output);
        }
        if read > MAX_REMOTE_OUTPUT_BYTES - output.len() {
            return Err(format!("{description} exceeded the 2 MiB limit"));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn accepts_output_at_the_limit() {
        let mut reader = tokio::io::repeat(b'x').take(MAX_REMOTE_OUTPUT_BYTES as u64);
        let output = read_limited(&mut reader, "test output").await.unwrap();
        assert_eq!(output.len(), MAX_REMOTE_OUTPUT_BYTES);
    }

    #[tokio::test]
    async fn rejects_output_over_the_limit() {
        let mut reader = tokio::io::repeat(b'x').take((MAX_REMOTE_OUTPUT_BYTES + 1) as u64);
        let error = read_limited(&mut reader, "test output").await.unwrap_err();
        assert!(error.contains("2 MiB limit"));
    }
}
