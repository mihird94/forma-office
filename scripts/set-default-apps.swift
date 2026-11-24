import Cocoa
import CoreServices
import UniformTypeIdentifiers

// Sets the installed /Applications/Forma *.app bundles as macOS default handlers
// for core Office, Markdown, PDF, and Jupyter Notebook formats (leaving .html untouched).

struct Mapping {
    let appPath: String
    let bundleId: String
    let extensions: [String]
    let extraUTIs: [String]
}

let mappings: [Mapping] = [
    Mapping(
        appPath: "/Applications/Forma Sheets.app",
        bundleId: "com.formaoffice.sheets",
        extensions: ["xlsx", "ods", "csv", "tsv"],
        extraUTIs: [
            "org.openxmlformats.spreadsheetml.sheet",
            "org.oasis-open.opendocument.spreadsheet",
            "public.comma-separated-values-text",
            "public.tab-separated-values-text",
        ]
    ),
    Mapping(
        appPath: "/Applications/Forma Docs.app",
        bundleId: "com.formaoffice.docs",
        extensions: ["docx", "odt", "md", "markdown"],
        extraUTIs: [
            "org.openxmlformats.wordprocessingml.document",
            "org.oasis-open.opendocument.text",
            "net.daringfireball.markdown",
        ]
    ),
    Mapping(
        appPath: "/Applications/Forma Slides.app",
        bundleId: "com.formaoffice.slides",
        extensions: ["pptx", "odp"],
        extraUTIs: [
            "org.openxmlformats.presentationml.presentation",
            "org.oasis-open.opendocument.presentation",
        ]
    ),
    Mapping(
        appPath: "/Applications/Forma PDF.app",
        bundleId: "com.formaoffice.pdf",
        extensions: ["pdf"],
        extraUTIs: ["com.adobe.pdf"]
    ),
    Mapping(
        appPath: "/Applications/Forma Lab.app",
        bundleId: "com.formaoffice.lab",
        extensions: ["ipynb"],
        extraUTIs: ["org.jupyter.notebook"]
    ),
    Mapping(
        appPath: "/Applications/Forma Canvas.app",
        bundleId: "com.formaoffice.canvas",
        extensions: ["fcanvas", "excalidraw"],
        extraUTIs: ["com.formaoffice.canvas-board", "com.excalidraw.drawing"]
    ),
]

let group = DispatchGroup()
let failuresLock = NSLock()
var failures: [String] = []

func recordFailure(_ msg: String) {
    failuresLock.lock()
    failures.append(msg)
    failuresLock.unlock()
}

for m in mappings {
    let appURL = URL(fileURLWithPath: m.appPath)
    guard FileManager.default.fileExists(atPath: appURL.path) else {
        recordFailure("Missing app: \(m.appPath)")
        continue
    }

    var utiIds = Set<String>(m.extraUTIs)
    for ext in m.extensions {
        if let ut = UTType(filenameExtension: ext) {
            utiIds.insert(ut.identifier)
        }
    }

    for uti in utiIds.sorted() {
        let status = LSSetDefaultRoleHandlerForContentType(
            uti as CFString,
            LSRolesMask.all,
            m.bundleId as CFString
        )
        if status != noErr {
            recordFailure("LSSetDefaultRoleHandler failed for \(uti) -> \(m.bundleId) (OSStatus \(status))")
        }

        if let contentType = UTType(uti) {
            group.enter()
            NSWorkspace.shared.setDefaultApplication(at: appURL, toOpen: contentType) { error in
                if let error {
                    recordFailure("NSWorkspace setDefault failed for \(uti) -> \(appURL.lastPathComponent): \(error.localizedDescription)")
                }
                group.leave()
            }
        }
    }
}

group.wait()

// Verify resolved default app per extension
print("Verified macOS default file associations:")
let verifyExts = ["xlsx", "ods", "csv", "tsv", "docx", "odt", "pptx", "odp", "pdf", "ipynb", "md", "fcanvas", "excalidraw", "html"]
for ext in verifyExts {
    if let ut = UTType(filenameExtension: ext) {
        let app = NSWorkspace.shared.urlForApplication(toOpen: ut)?.lastPathComponent ?? "none"
        print("  .\(ext)\t(\(ut.identifier))\t-> \(app)")
    }
}

if !failures.isEmpty {
    fputs("\nWarnings/Errors:\n", stderr)
    for f in failures {
        fputs("  - \(f)\n", stderr)
    }
    exit(1)
}
