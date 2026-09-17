//! Resource-table export: CSV text and a minimal, dependency-light XLSX writer.
//!
//! SpreadsheetML inline strings keep the XLSX writer small: every cell carries
//! its own text, so no shared-string table is needed, and the archive is a plain
//! zip with four XML parts that Excel, LibreOffice, and Numbers all open.

use std::io::{Cursor, Write};

use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

/// CSV fields are quoted only when needed so plain values stay readable.
fn csv_field(value: &str) -> String {
    if value.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn csv_row(values: &[String], output: &mut String) {
    let mut first = true;
    for value in values {
        if !first {
            output.push(',');
        }
        output.push_str(&csv_field(value));
        first = false;
    }
    output.push_str("\r\n");
}

/// UTF-8 BOM so Excel detects the encoding; CRLF rows for the same reason.
pub fn csv_bytes(columns: &[String], rows: &[Vec<String>]) -> Vec<u8> {
    let mut output = String::new();
    output.push('\u{feff}');
    csv_row(columns, &mut output);
    for row in rows {
        csv_row(row, &mut output);
    }
    output.into_bytes()
}

fn xml_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&apos;"),
            // XML 1.0 forbids most control characters; replace them instead of
            // producing a file Excel refuses to open.
            character if (character as u32) < 0x20 && !matches!(character, '\t' | '\n' | '\r') => {
                output.push(' ')
            }
            character => output.push(character),
        }
    }
    output
}

/// Spreadsheet column label for a zero-based index: 0 -> A, 25 -> Z, 26 -> AA.
fn column_name(mut index: usize) -> String {
    let mut name = String::new();
    loop {
        name.insert(0, (b'A' + (index % 26) as u8) as char);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    name
}

fn sanitize_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if "[]:*?/\\".contains(character) {
                ' '
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim();
    let cleaned = if cleaned.is_empty() {
        "Resources"
    } else {
        cleaned
    };
    cleaned.chars().take(31).collect()
}

fn worksheet_xml(columns: &[String], rows: &[Vec<String>]) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>",
    );
    let write_row = |xml: &mut String, number: usize, values: &[String]| {
        xml.push_str(&format!("<row r=\"{number}\">"));
        for (index, value) in values.iter().enumerate() {
            if value.is_empty() {
                continue;
            }
            let reference = format!("{}{number}", column_name(index));
            xml.push_str(&format!(
                "<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                xml_escape(value)
            ));
        }
        xml.push_str("</row>");
    };
    write_row(&mut xml, 1, columns);
    for (index, row) in rows.iter().enumerate() {
        write_row(&mut xml, index + 2, row);
    }
    xml.push_str("</sheetData></worksheet>");
    xml
}

fn zip_part(
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
    options: SimpleFileOptions,
    name: &str,
    contents: &str,
) -> Result<(), String> {
    zip.start_file(name, options)
        .map_err(|error| format!("Unable to write the spreadsheet part {name}: {error}"))?;
    zip.write_all(contents.as_bytes())
        .map_err(|error| format!("Unable to write the spreadsheet part {name}: {error}"))
}

pub fn xlsx_bytes(
    sheet_name: &str,
    columns: &[String],
    rows: &[Vec<String>],
) -> Result<Vec<u8>, String> {
    let sheet_name = sanitize_sheet_name(sheet_name);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip_part(
        &mut zip,
        options,
        "[Content_Types].xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
         <Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>\
         </Types>",
    )?;
    zip_part(
        &mut zip,
        options,
        "_rels/.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>\
         </Relationships>",
    )?;
    zip_part(
        &mut zip,
        options,
        "xl/workbook.xml",
        &format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
             <workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" \
             xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">\
             <sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
            xml_escape(&sheet_name)
        ),
    )?;
    zip_part(
        &mut zip,
        options,
        "xl/_rels/workbook.xml.rels",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>\
         </Relationships>",
    )?;
    zip_part(
        &mut zip,
        options,
        "xl/worksheets/sheet1.xml",
        &worksheet_xml(columns, rows),
    )?;

    zip.finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|error| format!("Unable to finish the spreadsheet: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    #[test]
    fn labels_spreadsheet_columns_beyond_z() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(51), "AZ");
        assert_eq!(column_name(52), "BA");
        assert_eq!(column_name(701), "ZZ");
        assert_eq!(column_name(702), "AAA");
    }

    #[test]
    fn quotes_csv_fields_only_when_required() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("line\nbreak"), "\"line\nbreak\"");
    }

    #[test]
    fn csv_starts_with_bom_and_crlf_rows() {
        let bytes = csv_bytes(
            &["Name".into(), "Namespace".into()],
            &[vec!["api,0".into(), "default".into()]],
        );
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with('\u{feff}'));
        assert!(text.contains("Name,Namespace\r\n"));
        assert!(text.contains("\"api,0\",default\r\n"));
    }

    #[test]
    fn xlsx_is_a_readable_zip_with_escaped_inline_strings() {
        let bytes = xlsx_bytes(
            "Pods:list",
            &["Name".into(), "Status".into()],
            &[
                vec!["api<x>".into(), "Running".into()],
                vec!["worker".into(), String::new()],
            ],
        )
        .unwrap();
        let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut sheet = String::new();
        archive
            .by_name("xl/worksheets/sheet1.xml")
            .unwrap()
            .read_to_string(&mut sheet)
            .unwrap();
        assert!(sheet.contains("api&lt;x&gt;"));
        assert!(sheet.contains("xml:space=\"preserve\""));
        assert!(sheet.contains("t=\"inlineStr\""));
        // An empty value is omitted instead of serialized as an empty cell.
        assert!(!sheet.contains("r=\"B3\""));
        let mut workbook = String::new();
        archive
            .by_name("xl/workbook.xml")
            .unwrap()
            .read_to_string(&mut workbook)
            .unwrap();
        assert!(workbook.contains("name=\"Pods list\""));
    }

    #[test]
    fn sheet_names_are_sanitized_and_bounded() {
        assert_eq!(
            sanitize_sheet_name("Custom/Resource:Name"),
            "Custom Resource Name"
        );
        assert_eq!(sanitize_sheet_name("   "), "Resources");
        assert_eq!(sanitize_sheet_name(&"x".repeat(40)).len(), 31);
    }
}
