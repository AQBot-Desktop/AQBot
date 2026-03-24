use std::path::Path;
use crate::error::{AQBotError, Result};

/// Extract plain text from a document file based on its MIME type.
pub fn extract_text(file_path: &Path, mime_type: &str) -> Result<String> {
    match mime_type {
        // Plain text files
        "text/plain" | "text/markdown" | "text/csv" | "text/html" | "text/xml"
        | "application/json" | "application/xml" => {
            std::fs::read_to_string(file_path)
                .map_err(|e| AQBotError::Provider(format!("Failed to read file: {e}")))
        }

        // PDF
        "application/pdf" => extract_pdf(file_path),

        // DOCX — basic XML extraction without external crate
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            extract_docx(file_path)
        }

        _ => {
            // Try reading as plain text as fallback
            std::fs::read_to_string(file_path)
                .map_err(|e| AQBotError::Provider(format!(
                    "Unsupported MIME type '{}', fallback read failed: {e}", mime_type
                )))
        }
    }
}

/// Extract text from PDF using pdf-extract crate.
fn extract_pdf(file_path: &Path) -> Result<String> {
    let bytes = std::fs::read(file_path)
        .map_err(|e| AQBotError::Provider(format!("Failed to read PDF file: {e}")))?;

    pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| AQBotError::Provider(format!("Failed to extract PDF text: {e}")))
}

/// Extract text from DOCX by reading the internal XML.
/// DOCX files are ZIP archives containing word/document.xml.
fn extract_docx(file_path: &Path) -> Result<String> {
    let file = std::fs::File::open(file_path)
        .map_err(|e| AQBotError::Provider(format!("Failed to open DOCX file: {e}")))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AQBotError::Provider(format!("Failed to read DOCX as ZIP: {e}")))?;

    let mut xml_content = String::new();
    if let Ok(mut entry) = archive.by_name("word/document.xml") {
        use std::io::Read;
        entry.read_to_string(&mut xml_content)
            .map_err(|e| AQBotError::Provider(format!("Failed to read document.xml: {e}")))?;
    } else {
        return Err(AQBotError::Provider("DOCX: word/document.xml not found".into()));
    }

    // Simple XML text extraction: find all <w:t> tag contents
    Ok(extract_text_from_xml(&xml_content))
}

/// Simple XML text extraction — pulls text from <w:t> and <w:t xml:space="preserve"> tags.
fn extract_text_from_xml(xml: &str) -> String {
    let mut result = String::new();
    let mut in_paragraph = false;

    // Track <w:p> boundaries for paragraph breaks
    for part in xml.split("<w:p") {
        if in_paragraph && !result.is_empty() {
            result.push('\n');
        }
        in_paragraph = true;

        // Extract text from <w:t> tags within this paragraph
        for segment in part.split("<w:t") {
            if let Some(text_start) = segment.find('>') {
                let after_tag = &segment[text_start + 1..];
                if let Some(end) = after_tag.find("</w:t>") {
                    result.push_str(&after_tag[..end]);
                }
            }
        }
    }

    result
}

/// Determine the MIME type from a file extension.
pub fn mime_from_extension(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xml" => "text/xml",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "text/plain",
    }
}
