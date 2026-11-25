import Foundation

@main struct HTMLExtractorTests {
    static func main() {
        let html = #"""
        <!doctype html><html><head><title>A &amp; B</title>
        <script>window.privateScript = 'not searchable'</script><style>.secret { color: red }</style></head>
        <body><h1>Gamma <em>Explorer</em></h1><p>Readable &amp; useful</p>
        <img src="https://example.invalid/no-fetch.png" alt="Revenue chart">
        <img src="data:image/png;base64,aGVsbG8=" alt="Inline diagram">
        <svg aria-label="Sales chart"><desc>Quarterly sales</desc></svg>
        <table><tr><th>Quarter</th><th>Sales</th></tr><tr><td>Q1</td><td>42</td></tr></table>
        <script type="application/forma-comments+json" id="forma-review-comments">[{"id":"1","author":"M","text":"Check <\/script> chart","pin":{"xPct":20,"yPct":30},"quote":"Sales"}]</script>
        </body></html>
        """#
        guard let result = FormaHTMLExtractor.extract(html) else { fatalError("HTML parse failed") }
        precondition(result.title == "A & B", "title was \(result.title ?? "nil")")
        for expected in ["# Gamma Explorer", "Readable & useful", "[Image: Revenue chart]", "[Image: Inline diagram]", "[Graphic: Sales chart; Quarterly sales]", "| Quarter | Sales |", "| Q1 | 42 |", "## Review Comments", "Check </script> chart", "[Pin 20%, 30%]", "> Sales"] {
            precondition(result.markdown.contains(expected), "Missing \(expected) in \(result.markdown)")
        }
        precondition(!result.markdown.contains("privateScript") && !result.markdown.contains("secret"))
        precondition(result.inlineImages.count == 1 && result.inlineImages[0].base64 == "aGVsbG8=")
        guard let malformed = FormaHTMLExtractor.extract("<title>Loose</title><h1>Heading <em>inside</em></h1><p>Unclosed") else { fatalError("Malformed HTML failed") }
        precondition(malformed.markdown.contains("Heading inside") && malformed.markdown.contains("Unclosed"))
        print("HTML extraction tests passed")
    }
}
