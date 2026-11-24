import Foundation
import CoreGraphics
import ImageIO
import PDFKit
import UniformTypeIdentifiers
import Vision

struct VisualIndexInput: Sendable {
    let sectionLabel: String
    let caption: String
    let base64: String
}

struct FormaExtractedDocument {
    let kind: String
    var title: String
    var text: String
    var images: [VisualIndexInput] = []
}

enum FormaDocExtractors {
    static let standaloneImages: Set<String> = ["png", "jpg", "jpeg", "webp"]

    static func kind(for ext: String, includeImages: Bool) -> String? {
        switch ext {
        case "pdf": return "pdf"
        case "docx", "odt", "md", "markdown", "txt", "html", "htm": return "document"
        case "xlsx", "ods", "csv", "tsv": return "spreadsheet"
        case "pptx", "odp": return "slides"
        case "ipynb": return "notebook"
        case "fcanvas", "excalidraw": return "canvas"
        case let image where includeImages && standaloneImages.contains(image): return "image"
        default: return nil
        }
    }

    static func extract(
        _ url: URL,
        config: FormaIndexConfig,
        includeVisuals: Bool,
        ocr: Bool? = nil
    ) throws -> FormaExtractedDocument {
        let ext = url.pathExtension.lowercased()
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        let size = values.fileSize ?? 0
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              size <= config.maximumFileBytes,
              let kind = kind(for: ext, includeImages: config.includeStandaloneImages) else {
            throw CocoaError(.fileReadUnsupportedScheme, userInfo: [NSFilePathErrorKey: url.path])
        }
        var document = FormaExtractedDocument(kind: kind, title: url.lastPathComponent, text: "")
        if size == 0 { return document }
        switch ext {
        case "pdf":
            guard let pdf = PDFDocument(url: url), !pdf.isLocked else { throw invalid(url) }
            var hadPageText = false
            var nonWhitespaceChars = 0
            let scannedPages = min(pdf.pageCount, 60)
            var sections: [String] = []
            for index in 0..<scannedPages {
                guard let page = pdf.page(at: index) else { continue }
                var text = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                hadPageText = hadPageText || !text.isEmpty
                nonWhitespaceChars += text.filter { !$0.isWhitespace }.count
                if ocr == true && text.isEmpty { text = recognizeText(page) }
                if !text.isEmpty { sections.append(section("Page \(index + 1)", text)) }
            }
            let sparseText = !hadPageText || (scannedPages > 0 && (nonWhitespaceChars / scannedPages) < 25)
            if ocr != true && sparseText {
                var ocrSections: [String] = []
                for index in 0..<min(pdf.pageCount, 8) {
                    guard let page = pdf.page(at: index) else { continue }
                    let existing = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let text = existing.count >= 25 ? existing : recognizeText(page)
                    if !text.isEmpty { ocrSections.append(section("Page \(index + 1)", text)) }
                }
                if ocrSections.joined().count > sections.joined().count {
                    sections = ocrSections
                }
            }
            document.text = sections.joined(separator: "\n\n")
            if includeVisuals { document.images = pdfVisuals(pdf, maxPages: config.pdfVisualPages) }
        case "docx":
            let zip = OfficeArchive(url: url)
            guard let docXml = zip.xml("word/document.xml") else { throw invalid(url) }
            let body = docXml.first("body") ?? docXml
            document.text = extractDocxBlocks(body).joined(separator: "\n\n")
            if includeVisuals { document.images = zip.visuals(prefix: "word/media/", limit: 3) }
        case "xlsx":
            let zip = OfficeArchive(url: url)
            guard let workbook = zip.xml("xl/workbook.xml") else { throw invalid(url) }
            let strings = zip.xml("xl/sharedStrings.xml")?.descendants("si").map {
                $0.descendants("t").map(\.text).joined()
            } ?? []
            let sheetRels = zip.xml("xl/_rels/workbook.xml.rels")?.descendants("Relationship") ?? []
            var refs: [String: String] = [:]
            for relation in sheetRels {
                guard let id = relation.attributes["Id"], let target = relation.attributes["Target"],
                      relation.attributes["Type"]?.hasSuffix("/worksheet") == true,
                      relation.attributes["TargetMode"] != "External" else { continue }
                let path = target.hasPrefix("/") ? String(target.dropFirst()) : "xl/" + target
                if path.hasPrefix("xl/worksheets/") && OfficeArchive.safeMember(path) { refs[id] = path }
            }
            document.text = workbook.descendants("sheet").enumerated().compactMap { index, sheet in
                let label = sheet.attributes["name"] ?? "Sheet \(index + 1)"
                let id = sheet.attributes.first { $0.key.hasSuffix(":id") }?.value
                let name = id.flatMap { refs[$0] } ?? "xl/worksheets/sheet\(index + 1).xml"
                guard let part = zip.xml(name, allowPrefix: true, rowLimit: 200) else { return nil }
                let rows: [[String]] = part.descendants("row").prefix(200).map { row in
                    row.children.filter { $0.name == "c" }.compactMap { cell -> String? in
                        let value = cell.first("v")?.text ?? ""
                        if cell.attributes["t"] == "s", let i = Int(value), strings.indices.contains(i) { return strings[i] }
                        if cell.attributes["t"] == "inlineStr" { return cell.descendants("t").map(\.text).joined() }
                        if cell.attributes["t"] == "b" { return value == "1" ? "TRUE" : "FALSE" }
                        return value.isEmpty ? cell.first("f").map { "=" + $0.text } : value
                    }
                }
                let md = markdownTable(rows)
                return md.isEmpty ? nil : section("Sheet: \(label)", md)
            }.joined(separator: "\n\n")
        case "pptx":
            let zip = OfficeArchive(url: url)
            let orderedSlides = zip.numberedMembers(in: "ppt/slides/", prefix: "slide")
            guard !orderedSlides.isEmpty else { throw invalid(url) }
            let notesMembers = Set(zip.numberedMembers(in: "ppt/notesSlides/", prefix: "notesSlide").map(\.path))
            document.text = orderedSlides.prefix(200).map { slide in
                let text = zip.xml(slide.path)?.descendants("t").map(\.text).joined(separator: "\n") ?? ""
                let related = "ppt/slides/_rels/\(URL(fileURLWithPath: slide.path).lastPathComponent).rels"
                let notesTarget = zip.xml(related)?.descendants("Relationship").first {
                    $0.attributes["Type"]?.hasSuffix("/notesSlide") == true && $0.attributes["TargetMode"] != "External"
                }?.attributes["Target"]
                let notes = notesTarget.map { "ppt/notesSlides/" + URL(fileURLWithPath: $0).lastPathComponent }
                    ?? "ppt/notesSlides/notesSlide\(slide.number).xml"
                let speakerNotes = notesMembers.contains(notes)
                    ? zip.xml(notes)?.descendants("t").map(\.text).joined(separator: "\n") ?? "" : ""
                return section("Slide \(slide.number)", speakerNotes.isEmpty ? text : text + "\nNotes:\n" + speakerNotes)
            }.joined(separator: "\n\n")
            if includeVisuals { document.images = zip.visuals(prefix: "ppt/media/", limit: 4) }
        case "odt", "ods", "odp":
            guard let root = OfficeArchive(url: url).xml("content.xml", allowPrefix: true) else { throw invalid(url) }
            if ext == "ods" {
                document.text = root.descendants("table").compactMap { table -> String? in
                    let name = table.attributes["table:name"] ?? "Sheet"
                    let rows: [[String]] = table.descendants("table-row").prefix(200).map { row in
                        row.children.filter { $0.name == "table-cell" }.map { cell in
                            cell.descendants("p").map(\.text).joined(separator: " ")
                        }
                    }
                    let md = markdownTable(rows)
                    return md.isEmpty ? nil : section("Sheet: \(name)", md)
                }.joined(separator: "\n\n")
            } else if ext == "odp", !root.descendants("page").isEmpty {
                document.text = root.descendants("page").enumerated().map { index, slide in
                    section("Slide \(index + 1)", paragraphs(slide))
                }.joined(separator: "\n\n")
            } else {
                let textRoot = root.first("body")?.first("text") ?? root
                document.text = extractOdtBlocks(textRoot).joined(separator: "\n\n")
            }
        case "ipynb":
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let cells = json?["cells"] as? [[String: Any]] else { throw invalid(url) }
            document.text = cells.prefix(1_000).enumerated().map { index, cell in
                let label = "Cell \(index + 1) (\(cell["cell_type"] as? String ?? "code"))"
                var parts = [stringValue(cell["source"])]
                for output in (cell["outputs"] as? [[String: Any]] ?? []).prefix(50) {
                    let mime = output["data"] as? [String: Any] ?? [:]
                    parts.append(stringValue(output["text"] ?? mime["text/plain"] ?? output["ename"]))
                    guard includeVisuals, document.images.count < 6 else { continue }
                    let type = output["output_type"] as? String
                    guard type == "display_data" || type == "execute_result" else { continue }
                    let raw = stringValue(mime["image/png"] ?? mime["image/jpeg"])
                    if let image = visual(base64: raw, label: "Cell \(index + 1) output") { document.images.append(image) }
                }
                return section(label, parts.map { String($0.prefix(16_384)) }.filter { !$0.isEmpty }.joined(separator: "\n"))
            }.joined(separator: "\n\n")
        case "fcanvas", "excalidraw":
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard let json, let elements = json["elements"] as? [[String: Any]] else { throw invalid(url) }
            if let title = json["title"] as? String, !title.isEmpty { document.title = title }
            let files = json["files"] as? [String: [String: Any]] ?? [:]
            document.text = elements.prefix(5_000).compactMap { element -> String? in
                guard element["isDeleted"] as? Bool != true else { return nil }
                let kind = element["kind"] as? String ?? element["type"] as? String ?? "element"
                let text = element["text"] as? String ?? element["name"] as? String ?? element["label"] as? String
                if includeVisuals, kind == "image", document.images.count < 4 {
                    let file = (element["fileId"] as? String).flatMap { files[$0] }
                    let dataURL = element["src"] as? String ?? element["dataURL"] as? String ?? file?["dataURL"] as? String ?? ""
                    if dataURL.hasPrefix("data:image/"), let comma = dataURL.firstIndex(of: ","),
                       let image = visual(base64: String(dataURL[dataURL.index(after: comma)...]), label: "Canvas image") {
                        document.images.append(image)
                    }
                }
                guard let text, !text.isEmpty else { return nil }
                return kind == "frame" ? section("Frame: \(text)", "") : "[\(kind)] \(text)"
            }.joined(separator: "\n")
        case let image where standaloneImages.contains(image):
            guard size < 10 * 1_048_576 else { throw invalid(url) }
            if includeVisuals {
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                guard let image = visual(data: data, label: "Image", maxSide: 768) else { throw invalid(url) }
                document.images = [image]
            }
        default:
            let file = try FileHandle(forReadingFrom: url)
            defer { try? file.close() }
            let data = try file.read(upToCount: 512 * 1024) ?? Data()
            document.text = String(decoding: data, as: UTF8.self)
            if ext == "html" || ext == "htm" {
                document.text = htmlToMarkdown(document.text)
            }
        }
        document.text = String(document.text.prefix(512 * 1024)).trimmingCharacters(in: .whitespacesAndNewlines)
        return document
    }

    static func pdfVisuals(at path: String, maxPages: Int) -> [VisualIndexInput] {
        guard let pdf = PDFDocument(url: URL(fileURLWithPath: path)) else { return [] }
        return pdfVisuals(pdf, maxPages: maxPages)
    }

    private static func pdfVisuals(_ pdf: PDFDocument, maxPages: Int) -> [VisualIndexInput] {
        let count = min(pdf.pageCount, maxPages)
        guard count > 0 else { return [] }
        return (0..<count).compactMap { sample in
            let index = count == 1 ? 0 : Int((Double(sample) * Double(pdf.pageCount - 1) / Double(count - 1)).rounded())
            guard let page = pdf.page(at: index), let image = render(page, maxSide: 640) else { return nil }
            return jpeg(image, label: "Page \(index + 1)")
        }
    }

    private static func render(_ page: PDFPage, maxSide: CGFloat) -> CGImage? {
        guard let reference = page.pageRef else { return nil }
        let bounds = page.bounds(for: .mediaBox)
        let scale = min(2, maxSide / max(1, bounds.width, bounds.height))
        let width = max(1, Int((bounds.width * scale).rounded()))
        let height = max(1, Int((bounds.height * scale).rounded()))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let target = CGRect(x: 0, y: 0, width: width, height: height)
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(target)
        context.interpolationQuality = .high
        context.concatenate(reference.getDrawingTransform(.mediaBox, rect: target, rotate: 0, preserveAspectRatio: true))
        context.drawPDFPage(reference)
        return context.makeImage()
    }

    private static func recognizeText(_ page: PDFPage) -> String {
        guard let image = render(page, maxSide: 2200) else { return "" }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        guard (try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])) != nil else { return "" }
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    fileprivate static func visual(data: Data, label: String, maxSide: Int = 640) -> VisualIndexInput? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxSide,
              ] as CFDictionary) else { return nil }
        return jpeg(image, label: label)
    }

    private static func visual(base64: String, label: String) -> VisualIndexInput? {
        guard !base64.isEmpty, base64.utf8.count <= 8_000_000,
              let bytes = Data(base64Encoded: base64.filter { !$0.isWhitespace }) else { return nil }
        return visual(data: bytes, label: label)
    }

    private static func jpeg(_ image: CGImage, label: String) -> VisualIndexInput? {
        let data = NSMutableData()
        guard let writer = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(writer, image, [kCGImageDestinationLossyCompressionQuality: 0.78] as CFDictionary)
        guard CGImageDestinationFinalize(writer) else { return nil }
        return VisualIndexInput(sectionLabel: label, caption: "", base64: data.base64EncodedString())
    }

    private static func section(_ label: String, _ body: String) -> String { "## \(label)\n\(body)" }

    private static func paragraphs(_ root: OfficeXMLNode) -> String {
        root.descendants(["p", "h"]).map(\.text).joined(separator: "\n")
    }

    private static func markdownTable(_ rawRows: [[String]]) -> String {
        let nonEmptyRows = rawRows.filter { row in
            row.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        }
        guard !nonEmptyRows.isEmpty else { return "" }
        let colCount = nonEmptyRows.map(\.count).max() ?? 0
        guard colCount > 0 else { return "" }

        func cleanCell(_ value: String) -> String {
            value
                .replacingOccurrences(of: "\r\n", with: " ")
                .replacingOccurrences(of: "\n", with: " ")
                .replacingOccurrences(of: "\t", with: " ")
                .replacingOccurrences(of: "|", with: "\\|")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }

        func formatRow(_ row: [String]) -> String {
            let padded = (0..<colCount).map { idx in
                idx < row.count ? cleanCell(row[idx]) : ""
            }
            return "| " + padded.joined(separator: " | ") + " |"
        }

        let header = formatRow(nonEmptyRows[0])
        let sep = "| " + Array(repeating: "---", count: colCount).joined(separator: " | ") + " |"
        let body = nonEmptyRows.dropFirst().map(formatRow)
        return ([header, sep] + body).joined(separator: "\n")
    }

    private static func extractDocxBlocks(_ container: OfficeXMLNode) -> [String] {
        var blocks: [String] = []
        for child in container.children {
            switch child.name {
            case "p":
                let text = child.descendants("t").map(\.text).joined()
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let pPr = child.first("pPr")
                let styleVal = (pPr?.first("pStyle")?.attributes.first {
                    $0.key == "w:val" || $0.key == "val"
                }?.value ?? "").lowercased()
                let prefix: String
                if styleVal == "title" || styleVal == "heading1" || styleVal == "heading 1" {
                    prefix = "# "
                } else if styleVal == "subtitle" || styleVal == "heading2" || styleVal == "heading 2" {
                    prefix = "## "
                } else if styleVal == "heading3" || styleVal == "heading 3" {
                    prefix = "### "
                } else if styleVal == "heading4" || styleVal == "heading 4" {
                    prefix = "#### "
                } else if styleVal == "heading5" || styleVal == "heading 5" {
                    prefix = "##### "
                } else if styleVal == "heading6" || styleVal == "heading 6" {
                    prefix = "###### "
                } else if styleVal.contains("list") || pPr?.first("numPr") != nil {
                    prefix = "- "
                } else {
                    prefix = ""
                }
                blocks.append(prefix + text)
            case "tbl":
                let rows: [[String]] = child.children.filter { $0.name == "tr" }.map { tr in
                    tr.children.filter { $0.name == "tc" }.map { tc in
                        tc.descendants("p")
                            .map { $0.descendants("t").map(\.text).joined() }
                            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                            .joined(separator: " ")
                    }
                }
                let md = markdownTable(rows)
                if !md.isEmpty { blocks.append(md) }
            case "sdt":
                blocks.append(contentsOf: extractDocxBlocks(child.first("sdtContent") ?? child))
            default:
                continue
            }
        }
        return blocks
    }

    private static func extractOdtBlocks(_ container: OfficeXMLNode) -> [String] {
        var blocks: [String] = []
        for child in container.children {
            switch child.name {
            case "h":
                let text = child.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let rawLevel = child.attributes.first {
                    $0.key == "text:outline-level" || $0.key == "outline-level"
                }?.value
                let level = rawLevel.flatMap(Int.init) ?? 1
                let hashes = String(repeating: "#", count: max(1, min(6, level)))
                blocks.append("\(hashes) \(text)")
            case "p":
                let text = child.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { blocks.append(text) }
            case "list":
                let items = child.descendants("list-item").map { item in
                    "- " + item.descendants("p").map(\.text).joined(separator: " ")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                }.filter { $0 != "- " }
                if !items.isEmpty { blocks.append(items.joined(separator: "\n")) }
            case "table":
                let rows: [[String]] = child.descendants("table-row").prefix(200).map { row in
                    row.children.filter { $0.name == "table-cell" }.map { cell in
                        cell.descendants("p").map(\.text).joined(separator: " ")
                    }
                }
                let md = markdownTable(rows)
                if !md.isEmpty { blocks.append(md) }
            default:
                let nested = extractOdtBlocks(child)
                blocks.append(contentsOf: nested)
            }
        }
        return blocks
    }

    private static func htmlToMarkdown(_ raw: String) -> String {
        var text = raw.replacingOccurrences(of: "(?is)<(script|style|noscript)\\b[^>]*>.*?</\\1>", with: "", options: .regularExpression)

        func decodeEntities(_ s: String) -> String {
            s.replacingOccurrences(of: "&nbsp;", with: " ")
                .replacingOccurrences(of: "&lt;", with: "<")
                .replacingOccurrences(of: "&gt;", with: ">")
                .replacingOccurrences(of: "&quot;", with: "\"")
                .replacingOccurrences(of: "&#39;", with: "'")
                .replacingOccurrences(of: "&amp;", with: "&")
        }

        func stripTags(_ s: String) -> String {
            decodeEntities(s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression))
                .replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }

        func replaceRegex(_ pattern: String, in input: String, transform: ([String]) -> String) -> String {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else {
                return input
            }
            let ns = input as NSString
            let matches = regex.matches(in: input, range: NSRange(location: 0, length: ns.length))
            guard !matches.isEmpty else { return input }
            var out = input
            for match in matches.reversed() {
                var groups: [String] = []
                for idx in 0..<match.numberOfRanges {
                    let r = match.range(at: idx)
                    groups.append(r.location != NSNotFound ? ns.substring(with: r) : "")
                }
                let replacement = transform(groups)
                if let swiftRange = Range(match.range, in: out) {
                    out.replaceSubrange(swiftRange, with: replacement)
                }
            }
            return out
        }

        text = replaceRegex("<pre\\b[^>]*>(.*?)</pre>", in: text) { groups in
            let inner = decodeEntities(groups[1].replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression))
                .trimmingCharacters(in: .newlines)
            return "\n```\n\(inner)\n```\n"
        }

        text = replaceRegex("<table\\b[^>]*>(.*?)</table>", in: text) { groups in
            guard let trRegex = try? NSRegularExpression(pattern: "<tr\\b[^>]*>(.*?)</tr>", options: [.caseInsensitive, .dotMatchesLineSeparators]),
                  let tdRegex = try? NSRegularExpression(pattern: "<t[hd]\\b[^>]*>(.*?)</t[hd]>", options: [.caseInsensitive, .dotMatchesLineSeparators]) else {
                return stripTags(groups[1])
            }
            let tbl = groups[1] as NSString
            var rows: [[String]] = []
            for tr in trRegex.matches(in: groups[1], range: NSRange(location: 0, length: tbl.length)).prefix(200) {
                let rowStr = tbl.substring(with: tr.range(at: 1))
                let rowNs = rowStr as NSString
                let cells = tdRegex.matches(in: rowStr, range: NSRange(location: 0, length: rowNs.length)).map { td in
                    stripTags(rowNs.substring(with: td.range(at: 1)))
                }
                if !cells.isEmpty { rows.append(cells) }
            }
            let md = markdownTable(rows)
            return md.isEmpty ? "" : "\n\n\(md)\n\n"
        }

        text = replaceRegex("<h([1-6])\\b[^>]*>(.*?)</h\\1>", in: text) { groups in
            let level = max(1, min(6, Int(groups[1]) ?? 1))
            let inner = stripTags(groups[2])
            return inner.isEmpty ? "" : "\n\n\(String(repeating: "#", count: level)) \(inner)\n\n"
        }

        text = replaceRegex("<li\\b[^>]*>(.*?)</li>", in: text) { groups in
            let inner = stripTags(groups[1])
            return inner.isEmpty ? "" : "\n- \(inner)"
        }

        text = replaceRegex("<code\\b[^>]*>(.*?)</code>", in: text) { groups in
            let inner = stripTags(groups[1])
            return inner.isEmpty ? "" : "`\(inner)`"
        }

        text = text
            .replacingOccurrences(of: "(?i)<br\\s*/?>", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "(?i)</?(?:p|div|section|article|blockquote|ul|ol)\\b[^>]*>", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        text = decodeEntities(text)
            .replacingOccurrences(of: "[ \\t]+\\n", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func stringValue(_ value: Any?) -> String {
        (value as? String) ?? (value as? [String])?.joined() ?? ""
    }

    private static func invalid(_ url: URL) -> CocoaError {
        CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: url.path])
    }
}

private struct OfficeArchive {
    let url: URL

    private func unzip(_ args: [String], limit: Int, allowPrefix: Bool = false) -> Data? {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = args
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let reader = output.fileHandleForReading
        defer { try? reader.close() }
        var bytes = Data()
        while let block = try? reader.read(upToCount: min(65_536, limit + 1 - bytes.count)), !block.isEmpty {
            bytes.append(block)
            if bytes.count > limit {
                if process.isRunning { process.terminate() }
                process.waitUntilExit()
                return allowPrefix ? Data(bytes.prefix(limit)) : nil
            }
        }
        process.waitUntilExit()
        return process.terminationStatus == 0 ? bytes : nil
    }

    static func safeMember(_ path: String) -> Bool {
        !path.split(separator: "/").contains("..") &&
            path.range(of: #"^[A-Za-z0-9_./-]+$"#, options: .regularExpression) != nil
    }

    private func members() -> [String] {
        guard let data = unzip(["-Z1", url.path], limit: 2_000_000) else { return [] }
        return String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline).map(String.init)
    }

    func xml(_ path: String, allowPrefix: Bool = false, rowLimit: Int? = nil) -> OfficeXMLNode? {
        guard Self.safeMember(path), let data = unzip(["-p", url.path, path], limit: 12_000_000, allowPrefix: allowPrefix)
        else { return nil }
        let reader = OfficeXMLReader(rowLimit: rowLimit)
        let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false
        parser.delegate = reader
        let valid = parser.parse()
        return valid || reader.stopped || (allowPrefix && data.count == 12_000_000) ? reader.root : nil
    }

    func numberedMembers(in folder: String, prefix: String) -> [(number: Int, path: String)] {
        members().compactMap { path -> (Int, String)? in
            guard path.hasPrefix(folder + prefix), path.hasSuffix(".xml"),
                  let number = Int(path.dropFirst(folder.count + prefix.count).dropLast(4)) else { return nil }
            return (number, path)
        }.sorted { $0.0 < $1.0 }
    }

    func visuals(prefix: String, limit: Int) -> [VisualIndexInput] {
        var images: [VisualIndexInput] = []
        for member in members() where member.hasPrefix(prefix) && Self.safeMember(member) {
            let ext = URL(fileURLWithPath: member).pathExtension.lowercased()
            guard ["png", "jpg", "jpeg"].contains(ext),
                  let data = unzip(["-p", url.path, member], limit: 2_000_000),
                  let visual = FormaDocExtractors.visual(data: data, label: "Embedded image \(images.count + 1)") else { continue }
            images.append(visual)
            if images.count == limit { break }
        }
        return images
    }
}

private final class OfficeXMLNode {
    enum Content { case characters(String), element(OfficeXMLNode) }

    let name: String
    let attributes: [String: String]
    var contents: [Content] = []
    var text: String {
        contents.map { item in
            switch item { case let .characters(value): return value; case let .element(node): return node.text }
        }.joined()
    }
    var children: [OfficeXMLNode] {
        contents.compactMap { if case let .element(node) = $0 { return node }; return nil }
    }

    init(name: String, attributes: [String: String]) {
        self.name = name.split(separator: ":").last.map(String.init) ?? name
        self.attributes = attributes
    }

    func first(_ name: String) -> OfficeXMLNode? { children.first { $0.name == name } }

    func descendants(_ name: String) -> [OfficeXMLNode] { descendants([name]) }

    func descendants(_ names: Set<String>) -> [OfficeXMLNode] {
        var matches: [OfficeXMLNode] = []
        var pending = Array(children.reversed())
        while let child = pending.popLast() {
            if names.contains(child.name) { matches.append(child) }
            pending.append(contentsOf: child.children.reversed())
        }
        return matches
    }
}

private final class OfficeXMLReader: NSObject, XMLParserDelegate {
    var root: OfficeXMLNode?
    private var stack: [OfficeXMLNode] = []
    private var rows = 0
    private let rowLimit: Int?
    var stopped = false

    init(rowLimit: Int?) { self.rowLimit = rowLimit }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?,
                attributes: [String: String]) {
        guard stack.count < 128 else { parser.abortParsing(); return }
        let node = OfficeXMLNode(name: name, attributes: attributes)
        if let parent = stack.last { parent.contents.append(.element(node)) } else { root = node }
        stack.append(node)
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
        stack.last?.contents.append(.characters(string))
    }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        if stack.popLast()?.name == "row", let limit = rowLimit {
            rows += 1
            if rows == limit { stopped = true; parser.abortParsing() }
        }
    }
}
