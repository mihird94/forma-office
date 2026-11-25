import Foundation
import libxml2

/// Static HTML extraction: never runs scripts or loads external resources.
enum FormaHTMLExtractor {
    struct Result {
        let title: String?
        let markdown: String
        let inlineImages: [(label: String, base64: String)]
    }

    static func extract(_ html: String) -> Result? {
        let bytes = Array(html.utf8)
        guard bytes.count <= Int(Int32.max),
              let parsed = bytes.withUnsafeBufferPointer({ buffer in
                  buffer.baseAddress.map { base in
                      htmlReadMemory(UnsafeRawPointer(base).assumingMemoryBound(to: CChar.self), Int32(buffer.count), nil, "UTF-8", Int32(HTML_PARSE_NONET.rawValue | HTML_PARSE_NOERROR.rawValue | HTML_PARSE_NOWARNING.rawValue | HTML_PARSE_RECOVER.rawValue))
                  } ?? nil
              }) else { return nil }
        defer { xmlFreeDoc(parsed) }
        var serialized: UnsafeMutablePointer<xmlChar>?
        var length: Int32 = 0
        xmlDocDumpMemory(parsed, &serialized, &length)
        guard let serialized, length > 0 else { return nil }
        defer { xmlFree(serialized) }
        let xml = Data(bytes: serialized, count: Int(length))
        guard let document = try? XMLDocument(data: xml, options: [.nodeLoadExternalEntitiesNever]),
              let root = document.rootElement() else { return nil }

        func name(_ node: XMLNode) -> String { (node.localName ?? node.name ?? "").lowercased() }
        func attribute(_ node: XMLNode, _ key: String) -> String? {
            (node as? XMLElement)?.attribute(forName: key)?.stringValue
        }
        func descendants(_ node: XMLNode, named target: String) -> [XMLNode] {
            var found: [XMLNode] = []
            for child in node.children ?? [] {
                if name(child) == target { found.append(child) }
                found.append(contentsOf: descendants(child, named: target))
            }
            return found
        }
        func clean(_ value: String) -> String {
            value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let title = descendants(root, named: "head").first.flatMap { descendants($0, named: "title").first }.map { clean($0.stringValue ?? "") }.flatMap { $0.isEmpty ? nil : $0 }
        var comments: [String] = []
        for script in descendants(root, named: "script") where attribute(script, "id") == "forma-review-comments" && attribute(script, "type")?.lowercased() == "application/forma-comments+json" {
            guard let data = script.stringValue?.data(using: .utf8),
                  let entries = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { continue }
            for entry in entries {
                guard let text = entry["text"] as? String else { continue }
                let author = entry["author"] as? String ?? "Reviewer"
                var line = "- \(author): \(text)"
                if (entry["resolved"] as? Bool) == true { line += " (resolved)" }
                if let pin = entry["pin"] as? [String: Any], let x = pin["xPct"], let y = pin["yPct"] { line += " [Pin \(x)%, \(y)%]" }
                if let quote = entry["quote"] as? String { line += "\n  > \(quote)" }
                comments.append(line)
            }
        }
        var images: [(label: String, base64: String)] = []
        func render(_ node: XMLNode, depth: Int = 0) -> String {
            guard depth < 128 else { return "" }
            if node.kind == .text { return node.stringValue ?? "" }
            let tag = name(node)
            if ["head", "script", "style", "noscript", "template"].contains(tag) { return "" }
            if tag == "img" {
                let alt = clean(attribute(node, "alt") ?? attribute(node, "title") ?? "")
                let src = attribute(node, "src") ?? ""
                if images.count < 4, src.count <= 2_800_000,
                   src.lowercased().hasPrefix("data:image/"), let comma = src.firstIndex(of: ","),
                   src[..<comma].lowercased().contains(";base64") {
                    images.append((alt.isEmpty ? "HTML image \(images.count + 1)" : alt, String(src[src.index(after: comma)...])))
                }
                if src.lowercased().hasPrefix("data:") { return alt.isEmpty ? "" : " [Image: \(alt)] " }
                let reference = clean(src)
                let label = alt.isEmpty ? "Image" : "Image: \(alt)"
                return reference.isEmpty ? (alt.isEmpty ? "" : " [\(label)] ") : " [\(label)] (\(String(reference.prefix(2048)))) "
            }
            if tag == "svg" {
                let desc = [attribute(node, "aria-label"), descendants(node, named: "title").first?.stringValue, descendants(node, named: "desc").first?.stringValue].compactMap { $0 }.map(clean).filter { !$0.isEmpty }
                return desc.isEmpty ? "" : " [Graphic: \(desc.joined(separator: "; "))] "
            }
            let contents = (node.children ?? []).map { render($0, depth: depth + 1) }.joined()
            switch tag {
            case "h1", "h2", "h3", "h4", "h5", "h6":
                let level = Int(tag.suffix(1)) ?? 1
                let text = clean(contents)
                return text.isEmpty ? "" : "\n\n\(String(repeating: "#", count: level)) \(text)\n\n"
            case "li": return "\n- \(clean(contents))\n"
            case "br": return "\n"
            case "pre": return "\n\n```\n\(contents.trimmingCharacters(in: .newlines))\n```\n\n"
            case "tr":
                let cells = (node.children ?? []).filter { ["td", "th"].contains(name($0)) }.map { clean(render($0, depth: depth + 1)).replacingOccurrences(of: "|", with: "\\|") }
                return cells.isEmpty ? "" : "\n| " + cells.joined(separator: " | ") + " |\n"
            case "table":
                let rows = descendants(node, named: "tr").map { row in
                    (row.children ?? []).filter { ["td", "th"].contains(name($0)) }.map { clean(render($0, depth: depth + 1)).replacingOccurrences(of: "|", with: "\\|") }
                }.filter { !$0.isEmpty }
                guard let first = rows.first else { return "\n\n\(contents)\n\n" }
                let width = rows.map(\.count).max() ?? first.count
                let lines = rows.enumerated().flatMap { index, row -> [String] in
                    let padded = row + Array(repeating: "", count: max(0, width - row.count))
                    let line = "| " + padded.joined(separator: " | ") + " |"
                    return index == 0 ? [line, "| " + Array(repeating: "---", count: width).joined(separator: " | ") + " |"] : [line]
                }
                return "\n\n" + lines.joined(separator: "\n") + "\n\n"
            case "p", "div", "section", "article", "blockquote", "ul", "ol", "figure", "figcaption": return "\n\n\(contents)\n\n"
            default: return contents
            }
        }
        let body = descendants(root, named: "body").first ?? root
        var markdown = render(body).replacingOccurrences(of: "[ \\t]+\\n", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "\\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !comments.isEmpty { markdown += "\n\n## Review Comments\n\n" + comments.joined(separator: "\n\n") }
        return Result(title: title, markdown: markdown, inlineImages: images)
    }
}
