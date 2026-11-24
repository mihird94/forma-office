import Cocoa
import Carbon.HIToolbox
import Darwin

// MARK: - Sendable Models

private struct SpotlightHit: Sendable, Equatable {
    let docId: String
    let kind: String
    let title: String
    let path: String
    let sectionLabel: String
    let snippet: String
    let score: Double
    let matchType: String

    init?(dictionary: [String: Any]) {
        guard let title = dictionary["title"] as? String else { return nil }
        self.docId = dictionary["docId"] as? String ?? ""
        self.kind = (dictionary["kind"] as? String ?? "document").lowercased()
        self.title = title
        self.path = dictionary["path"] as? String ?? ""
        self.sectionLabel = (dictionary["sectionLabel"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.snippet = (dictionary["snippet"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if let s = dictionary["score"] as? Double {
            self.score = s
        } else if let n = dictionary["score"] as? NSNumber {
            self.score = n.doubleValue
        } else {
            self.score = 0
        }
        self.matchType = (dictionary["matchType"] as? String ?? "lexical").lowercased()
    }
}

private struct SpotlightStatus: Sendable {
    let indexedDocs: Int
    let indexedChunks: Int
    let embedOnline: Bool
    let embedModel: String
    let multimodal: Bool

    init(dictionary: [String: Any]) {
        self.indexedDocs = (dictionary["indexedDocs"] as? Int)
            ?? (dictionary["indexedDocs"] as? NSNumber)?.intValue ?? 0
        self.indexedChunks = (dictionary["indexedChunks"] as? Int)
            ?? (dictionary["indexedChunks"] as? NSNumber)?.intValue ?? 0
        self.embedOnline = (dictionary["embedOnline"] as? Bool) ?? false
        self.embedModel = (dictionary["embedModel"] as? String) ?? "embeddinggemma-2"
        self.multimodal = (dictionary["multimodal"] as? Bool) ?? false
    }
}

private struct FormaKindDescriptor {
    let filterTitle: String
    let badgeTitle: String
    let kindValue: String?
    let appName: String?
    let bundleId: String?
    let accentColor: NSColor

    static let filters: [FormaKindDescriptor] = [
        FormaKindDescriptor(filterTitle: "All", badgeTitle: "All", kindValue: nil, appName: nil, bundleId: nil, accentColor: .controlAccentColor),
        FormaKindDescriptor(filterTitle: "Docs", badgeTitle: "Docs", kindValue: "document", appName: "Forma Docs", bundleId: "com.formaoffice.docs", accentColor: NSColor(calibratedRed: 0.18, green: 0.49, blue: 0.96, alpha: 1.0)),
        FormaKindDescriptor(filterTitle: "Sheets", badgeTitle: "Sheets", kindValue: "spreadsheet", appName: "Forma Sheets", bundleId: "com.formaoffice.sheets", accentColor: NSColor(calibratedRed: 0.13, green: 0.63, blue: 0.42, alpha: 1.0)),
        FormaKindDescriptor(filterTitle: "Slides", badgeTitle: "Slides", kindValue: "slides", appName: "Forma Slides", bundleId: "com.formaoffice.slides", accentColor: NSColor(calibratedRed: 0.90, green: 0.48, blue: 0.12, alpha: 1.0)),
        FormaKindDescriptor(filterTitle: "PDF", badgeTitle: "PDF", kindValue: "pdf", appName: "Forma PDF", bundleId: "com.formaoffice.pdf", accentColor: NSColor(calibratedRed: 0.90, green: 0.28, blue: 0.30, alpha: 1.0)),
        FormaKindDescriptor(filterTitle: "Lab", badgeTitle: "Lab", kindValue: "notebook", appName: "Forma Lab", bundleId: "com.formaoffice.lab", accentColor: NSColor(calibratedRed: 0.55, green: 0.36, blue: 0.96, alpha: 1.0)),
        FormaKindDescriptor(filterTitle: "Canvas", badgeTitle: "Canvas", kindValue: "canvas", appName: "Forma Canvas", bundleId: "com.formaoffice.canvas", accentColor: NSColor(calibratedRed: 0.05, green: 0.65, blue: 0.64, alpha: 1.0)),
        FormaKindDescriptor(filterTitle: "Images", badgeTitle: "Image", kindValue: "image", appName: nil, bundleId: nil, accentColor: NSColor(calibratedRed: 0.85, green: 0.27, blue: 0.56, alpha: 1.0)),
    ]

    static func descriptor(for kind: String) -> FormaKindDescriptor {
        let lower = kind.lowercased()
        if let found = filters.first(where: { $0.kindValue == lower }) {
            return found
        }
        return FormaKindDescriptor(
            filterTitle: lower.capitalized,
            badgeTitle: lower.isEmpty ? "File" : lower.capitalized,
            kindValue: lower,
            appName: nil,
            bundleId: nil,
            accentColor: .systemGray
        )
    }
}

// MARK: - Configurable Hotkey Combo & Persistence

private struct HotKeyCombo: Equatable, Sendable {
    let keyCode: UInt32
    let carbonModifiers: UInt32

    private static let savedCodeKey = "formaSearch.hotKeyCode"
    private static let savedModifiersKey = "formaSearch.hotKeyModifiers"
    private static let supportedModifiersMask = UInt32(controlKey | optionKey | shiftKey | cmdKey)

    static let defaultCombo = HotKeyCombo(
        keyCode: UInt32(kVK_Space),
        carbonModifiers: UInt32(controlKey)
    )

    static let presets: [HotKeyCombo] = [
        HotKeyCombo(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(controlKey)),
        HotKeyCombo(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(optionKey | shiftKey)),
        HotKeyCombo(keyCode: UInt32(kVK_ANSI_F), carbonModifiers: UInt32(optionKey)),
        HotKeyCombo(keyCode: UInt32(kVK_ANSI_F), carbonModifiers: UInt32(cmdKey | shiftKey)),
        HotKeyCombo(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(controlKey | optionKey)),
        HotKeyCombo(keyCode: UInt32(kVK_ANSI_F), carbonModifiers: UInt32(optionKey | cmdKey)),
    ]

    var normalizedModifiers: UInt32 {
        carbonModifiers & Self.supportedModifiersMask
    }

    var label: String {
        Self.modifierSymbols(for: normalizedModifiers) + Self.keyName(for: keyCode)
    }

    static func modifierSymbols(for modifiers: UInt32) -> String {
        var out = ""
        if (modifiers & UInt32(controlKey)) != 0 { out += "⌃" }
        if (modifiers & UInt32(optionKey)) != 0 { out += "⌥" }
        if (modifiers & UInt32(shiftKey)) != 0 { out += "⇧" }
        if (modifiers & UInt32(cmdKey)) != 0 { out += "⌘" }
        return out
    }

    static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
        var mods: UInt32 = 0
        if flags.contains(.control) { mods |= UInt32(controlKey) }
        if flags.contains(.option) { mods |= UInt32(optionKey) }
        if flags.contains(.shift) { mods |= UInt32(shiftKey) }
        if flags.contains(.command) { mods |= UInt32(cmdKey) }
        return mods
    }

    static func hasPrimaryModifier(_ carbonModifiers: UInt32) -> Bool {
        (carbonModifiers & UInt32(cmdKey | optionKey | controlKey)) != 0
    }

    static func loadSaved() -> HotKeyCombo? {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: savedCodeKey) != nil,
              defaults.object(forKey: savedModifiersKey) != nil else {
            return nil
        }
        let code = UInt32(bitPattern: Int32(defaults.integer(forKey: savedCodeKey)))
        let mods = UInt32(bitPattern: Int32(defaults.integer(forKey: savedModifiersKey))) & supportedModifiersMask
        guard hasPrimaryModifier(mods) else { return nil }
        return HotKeyCombo(keyCode: code, carbonModifiers: mods)
    }

    func save() {
        let defaults = UserDefaults.standard
        defaults.set(Int(Int32(bitPattern: keyCode)), forKey: Self.savedCodeKey)
        defaults.set(Int(Int32(bitPattern: normalizedModifiers)), forKey: Self.savedModifiersKey)
    }

    static func keyName(for keyCode: UInt32) -> String {
        switch Int(keyCode) {
        case kVK_Space: return "Space"
        case kVK_Return: return "Return"
        case kVK_Tab: return "Tab"
        case kVK_Escape: return "Esc"
        case kVK_Delete: return "⌫"
        case kVK_ForwardDelete: return "⌦"
        case kVK_LeftArrow: return "←"
        case kVK_RightArrow: return "→"
        case kVK_UpArrow: return "↑"
        case kVK_DownArrow: return "↓"
        case kVK_ANSI_A: return "A"
        case kVK_ANSI_B: return "B"
        case kVK_ANSI_C: return "C"
        case kVK_ANSI_D: return "D"
        case kVK_ANSI_E: return "E"
        case kVK_ANSI_F: return "F"
        case kVK_ANSI_G: return "G"
        case kVK_ANSI_H: return "H"
        case kVK_ANSI_I: return "I"
        case kVK_ANSI_J: return "J"
        case kVK_ANSI_K: return "K"
        case kVK_ANSI_L: return "L"
        case kVK_ANSI_M: return "M"
        case kVK_ANSI_N: return "N"
        case kVK_ANSI_O: return "O"
        case kVK_ANSI_P: return "P"
        case kVK_ANSI_Q: return "Q"
        case kVK_ANSI_R: return "R"
        case kVK_ANSI_S: return "S"
        case kVK_ANSI_T: return "T"
        case kVK_ANSI_U: return "U"
        case kVK_ANSI_V: return "V"
        case kVK_ANSI_W: return "W"
        case kVK_ANSI_X: return "X"
        case kVK_ANSI_Y: return "Y"
        case kVK_ANSI_Z: return "Z"
        case kVK_ANSI_0: return "0"
        case kVK_ANSI_1: return "1"
        case kVK_ANSI_2: return "2"
        case kVK_ANSI_3: return "3"
        case kVK_ANSI_4: return "4"
        case kVK_ANSI_5: return "5"
        case kVK_ANSI_6: return "6"
        case kVK_ANSI_7: return "7"
        case kVK_ANSI_8: return "8"
        case kVK_ANSI_9: return "9"
        case kVK_F1: return "F1"
        case kVK_F2: return "F2"
        case kVK_F3: return "F3"
        case kVK_F4: return "F4"
        case kVK_F5: return "F5"
        case kVK_F6: return "F6"
        case kVK_F7: return "F7"
        case kVK_F8: return "F8"
        case kVK_F9: return "F9"
        case kVK_F10: return "F10"
        case kVK_F11: return "F11"
        case kVK_F12: return "F12"
        case kVK_ANSI_Minus: return "-"
        case kVK_ANSI_Equal: return "="
        case kVK_ANSI_LeftBracket: return "["
        case kVK_ANSI_RightBracket: return "]"
        case kVK_ANSI_Semicolon: return ";"
        case kVK_ANSI_Quote: return "'"
        case kVK_ANSI_Comma: return ","
        case kVK_ANSI_Period: return "."
        case kVK_ANSI_Slash: return "/"
        case kVK_ANSI_Backslash: return "\\"
        case kVK_ANSI_Grave: return "`"
        default: return "Key\(keyCode)"
        }
    }
}

private enum ShortcutRegistrationError: Error {
    case eventHandlerMissing
    case conflict(combo: HotKeyCombo, status: OSStatus)

    var userMessage: String {
        switch self {
        case .eventHandlerMissing:
            return "Could not attach macOS keyboard listener — try relaunching Forma Search."
        case .conflict(let combo, _):
            return "\(combo.label) is already in use by another app — try another combo"
        }
    }
}

// MARK: - Carbon Hotkey Callback Bridge

private let formaHotKeySignature: OSType = 0x46524D41 // 'FRMA'
private let formaHotKeyId: UInt32 = 1

private func formaHotKeyHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let event, let userData else { return OSStatus(eventNotHandledErr) }
    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    guard status == noErr,
          hotKeyID.signature == formaHotKeySignature,
          hotKeyID.id == formaHotKeyId else {
        return OSStatus(eventNotHandledErr)
    }

    let delegate = Unmanaged<FormaSpotlightAppDelegate>.fromOpaque(userData).takeUnretainedValue()
    Task { @MainActor in
        delegate.togglePanel()
    }
    return noErr
}

// MARK: - Floating Spotlight Panel

private final class SpotlightPanel: NSPanel {
    var onCommandReturn: (() -> Void)?
    var onEscape: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.contains(.command), event.keyCode == 36 || event.keyCode == 76 {
            onCommandReturn?()
            return true
        }
        if event.keyCode == 53 { // Escape
            onEscape?()
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

// MARK: - Backdrop View with Adaptive Border

private final class SpotlightBackdropView: NSVisualEffectView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        updateBorderColor()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateBorderColor()
    }

    private func updateBorderColor() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.16).cgColor
        }
    }
}

// MARK: - Filter Pill Button

private final class FilterPillButton: NSButton {
    let kindValue: String?
    private let pillAccent: NSColor
    private var isActivePill = false

    override var acceptsFirstResponder: Bool { false }

    init(descriptor: FormaKindDescriptor, target: AnyObject?, action: Selector) {
        self.kindValue = descriptor.kindValue
        self.pillAccent = descriptor.accentColor
        super.init(frame: .zero)
        title = descriptor.filterTitle
        self.target = target
        self.action = action
        isBordered = false
        bezelStyle = .inline
        font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        wantsLayer = true
        layer?.cornerRadius = 11
        layer?.masksToBounds = true
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 22),
        ])
        updateAppearance()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize {
        let base = super.intrinsicContentSize
        return NSSize(width: base.width + 18, height: 22)
    }

    func setActive(_ active: Bool) {
        isActivePill = active
        updateAppearance()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateAppearance()
    }

    private func updateAppearance() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let fg: NSColor
            if isActivePill {
                layer?.backgroundColor = pillAccent.cgColor
                fg = .white
            } else {
                layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.08).cgColor
                fg = .secondaryLabelColor
            }
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            attributedTitle = NSAttributedString(
                string: title,
                attributes: [
                    .font: NSFont.systemFont(ofSize: 11.5, weight: isActivePill ? .semibold : .medium),
                    .foregroundColor: fg,
                    .paragraphStyle: paragraph,
                ]
            )
        }
    }
}

// MARK: - Badge Pill View

private final class BadgePillView: NSView {
    private let label = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 5
        layer?.masksToBounds = true
        translatesAutoresizingMaskIntoConstraints = false

        label.font = NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .semibold)
        label.alignment = .center
        label.lineBreakMode = .byClipping
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)

        addSubview(label)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 18),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(text: String, tint: NSColor, subtle: Bool = false) {
        label.stringValue = text
        label.textColor = subtle ? .secondaryLabelColor : tint
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = subtle
                ? NSColor.labelColor.withAlphaComponent(0.08).cgColor
                : tint.withAlphaComponent(0.18).cgColor
        }
    }
}

// MARK: - Result Row Cell View

private final class SpotlightResultCellView: NSTableCellView {
    static let reuseId = NSUserInterfaceItemIdentifier("FormaSpotlightResultCell")

    private let cardView = NSView()
    private let kindBadge = BadgePillView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let sectionLabel = NSTextField(labelWithString: "")
    private let scoreBadge = BadgePillView()
    private let snippetLabel = NSTextField(wrappingLabelWithString: "")
    private let pathLabel = NSTextField(labelWithString: "")

    private var currentHit: SpotlightHit?
    private var isSelectedRow = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupViews()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func setupViews() {
        cardView.wantsLayer = true
        cardView.layer?.cornerRadius = 10
        cardView.layer?.masksToBounds = true
        cardView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(cardView)

        titleLabel.font = NSFont.systemFont(ofSize: 13.5, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.maximumNumberOfLines = 1
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        sectionLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        sectionLabel.textColor = .secondaryLabelColor
        sectionLabel.lineBreakMode = .byTruncatingTail
        sectionLabel.maximumNumberOfLines = 1
        sectionLabel.setContentCompressionResistancePriority(.fittingSizeCompression, for: .horizontal)
        sectionLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.fittingSizeCompression, for: .horizontal)

        let topRow = NSStackView(views: [kindBadge, titleLabel, sectionLabel, spacer, scoreBadge])
        topRow.orientation = .horizontal
        topRow.alignment = .centerY
        topRow.spacing = 7
        topRow.translatesAutoresizingMaskIntoConstraints = false

        snippetLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .regular)
        snippetLabel.textColor = .secondaryLabelColor
        snippetLabel.maximumNumberOfLines = 2
        snippetLabel.lineBreakMode = .byTruncatingTail
        snippetLabel.cell?.truncatesLastVisibleLine = true
        snippetLabel.translatesAutoresizingMaskIntoConstraints = false

        pathLabel.font = NSFont.systemFont(ofSize: 10.5, weight: .regular)
        pathLabel.textColor = .tertiaryLabelColor
        pathLabel.lineBreakMode = .byTruncatingMiddle
        pathLabel.maximumNumberOfLines = 1
        pathLabel.translatesAutoresizingMaskIntoConstraints = false

        cardView.addSubview(topRow)
        cardView.addSubview(snippetLabel)
        cardView.addSubview(pathLabel)

        NSLayoutConstraint.activate([
            cardView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            cardView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            cardView.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            cardView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2),

            topRow.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            topRow.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            topRow.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 6),
            topRow.heightAnchor.constraint(equalToConstant: 18),

            snippetLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            snippetLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            snippetLabel.topAnchor.constraint(equalTo: topRow.bottomAnchor, constant: 3),

            pathLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            pathLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            pathLabel.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -5),
        ])
    }

    func configure(hit: SpotlightHit, selected: Bool, homePath: String) {
        currentHit = hit
        isSelectedRow = selected

        let desc = FormaKindDescriptor.descriptor(for: hit.kind)
        kindBadge.configure(text: desc.badgeTitle, tint: desc.accentColor)
        titleLabel.stringValue = hit.title

        if hit.sectionLabel.isEmpty {
            sectionLabel.stringValue = ""
            sectionLabel.isHidden = true
        } else {
            sectionLabel.stringValue = "· \(hit.sectionLabel)"
            sectionLabel.isHidden = false
        }

        if hit.matchType == "hybrid" {
            let pct = max(1, min(99, Int((hit.score * 100.0).rounded())))
            scoreBadge.configure(text: "AI \(pct)%", tint: .systemIndigo, subtle: false)
        } else {
            scoreBadge.configure(text: "Lexical", tint: .secondaryLabelColor, subtle: true)
        }

        snippetLabel.stringValue = hit.snippet.isEmpty ? "Matching document content" : hit.snippet
        pathLabel.stringValue = Self.shortenPath(hit.path, homePath: homePath)

        updateSelectionAppearance()
    }

    func setSelectedRow(_ selected: Bool) {
        guard isSelectedRow != selected else { return }
        isSelectedRow = selected
        updateSelectionAppearance()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        if let hit = currentHit {
            let desc = FormaKindDescriptor.descriptor(for: hit.kind)
            kindBadge.configure(text: desc.badgeTitle, tint: desc.accentColor)
            if hit.matchType == "hybrid" {
                let pct = max(1, min(99, Int((hit.score * 100.0).rounded())))
                scoreBadge.configure(text: "AI \(pct)%", tint: .systemIndigo, subtle: false)
            } else {
                scoreBadge.configure(text: "Lexical", tint: .secondaryLabelColor, subtle: true)
            }
        }
        updateSelectionAppearance()
    }

    private func updateSelectionAppearance() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            if isSelectedRow {
                cardView.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.18).cgColor
                cardView.layer?.borderWidth = 1
                cardView.layer?.borderColor = NSColor.controlAccentColor.withAlphaComponent(0.36).cgColor
            } else {
                cardView.layer?.backgroundColor = NSColor.clear.cgColor
                cardView.layer?.borderWidth = 0
                cardView.layer?.borderColor = nil
            }
        }
    }

    private static func shortenPath(_ path: String, homePath: String) -> String {
        guard !path.isEmpty else { return "Forma Workspace" }
        if path == homePath { return "~" }
        if path.hasPrefix(homePath + "/") {
            return "~" + String(path.dropFirst(homePath.count))
        }
        return path
    }
}

// MARK: - Spotlight Panel Controller

@MainActor
private final class FormaSpotlightController: NSObject, NSWindowDelegate, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private static let panelWidth: CGFloat = 680
    private static let collapsedHeight: CGFloat = 118
    private static let maxExpandedHeight: CGFloat = 500
    private static let rowHeight: CGFloat = 80

    private let panel: SpotlightPanel
    private let backdrop = SpotlightBackdropView()
    private let searchField = NSTextField()
    private let spinner = NSProgressIndicator()
    private let clearButton = NSButton()
    private var pillButtons: [FilterPillButton] = []
    private let resultsContainer = NSView()
    private let scrollView = NSScrollView()
    private let tableView = NSTableView()
    private let emptyLabel = NSTextField(labelWithString: "")
    private let bottomDivider = NSBox()
    private let statusLabel = NSTextField(labelWithString: "Loading Forma index…")
    private let shortcutButton = NSButton()
    private let hintsLabel = NSTextField(labelWithString: "↵ Open · ⌘↵ Reveal · ⎋ Close")

    private let homePath = FileManager.default.homeDirectoryForCurrentUser.path
    private let numberFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter
    }()

    private var selectedKindFilter: String? = nil
    private var hits: [SpotlightHit] = []
    private var selectedIndex: Int = -1
    private var searchSequence: UInt64 = 0
    private var lexicalWorkItem: DispatchWorkItem?
    private var hybridWorkItem: DispatchWorkItem?
    private var isWaitingForSearch = false
    private var isSyncingFolders = false
    private var latestStatus: SpotlightStatus?
    private var anchoredTopY: CGFloat?
    private var lastDismissedAt: TimeInterval = 0

    var onOpenShortcutPicker: (() -> Void)?
    var isVisible: Bool { panel.isVisible }

    override init() {
        let initialRect = NSRect(x: 0, y: 0, width: Self.panelWidth, height: Self.collapsedHeight)
        self.panel = SpotlightPanel(
            contentRect: initialRect,
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()
        configurePanel()
        buildUI()
        refreshStatus()
    }

    private func configurePanel() {
        panel.delegate = self
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.animationBehavior = .none

        panel.onCommandReturn = { [weak self] in
            self?.revealSelectedHit()
        }
        panel.onEscape = { [weak self] in
            self?.dismiss(restorePreviousApp: true)
        }
    }

    private func buildUI() {
        backdrop.translatesAutoresizingMaskIntoConstraints = true
        backdrop.autoresizingMask = [.width, .height]
        backdrop.frame = panel.contentView?.bounds ?? NSRect(x: 0, y: 0, width: Self.panelWidth, height: Self.collapsedHeight)
        panel.contentView = backdrop

        // 1. Top search bar
        let searchBar = NSView()
        searchBar.translatesAutoresizingMaskIntoConstraints = false

        let searchIcon = NSImageView()
        if let symbol = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "Search") {
            let config = NSImage.SymbolConfiguration(pointSize: 18, weight: .medium)
            searchIcon.image = symbol.withSymbolConfiguration(config)
        }
        searchIcon.contentTintColor = .secondaryLabelColor
        searchIcon.translatesAutoresizingMaskIntoConstraints = false

        searchField.placeholderString = "Search Forma docs, PDFs, slides, sheets, canvas & images…"
        searchField.font = NSFont.systemFont(ofSize: 18, weight: .regular)
        searchField.textColor = .labelColor
        searchField.isBordered = false
        searchField.isBezeled = false
        searchField.drawsBackground = false
        searchField.focusRingType = .none
        searchField.usesSingleLineMode = true
        searchField.lineBreakMode = .byTruncatingTail
        searchField.delegate = self
        searchField.translatesAutoresizingMaskIntoConstraints = false

        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.isDisplayedWhenStopped = false
        spinner.translatesAutoresizingMaskIntoConstraints = false

        if let clearImg = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Clear") {
            let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)
            clearButton.image = clearImg.withSymbolConfiguration(config)
        } else {
            clearButton.title = "×"
        }
        clearButton.isBordered = false
        clearButton.contentTintColor = .tertiaryLabelColor
        clearButton.target = self
        clearButton.action = #selector(clearSearchClicked)
        clearButton.isHidden = true
        clearButton.translatesAutoresizingMaskIntoConstraints = false

        searchBar.addSubview(searchIcon)
        searchBar.addSubview(searchField)
        searchBar.addSubview(spinner)
        searchBar.addSubview(clearButton)

        // 2. Filter pill row
        let pillsStack = NSStackView()
        pillsStack.orientation = .horizontal
        pillsStack.alignment = .centerY
        pillsStack.spacing = 6
        pillsStack.translatesAutoresizingMaskIntoConstraints = false

        for descriptor in FormaKindDescriptor.filters {
            let pill = FilterPillButton(descriptor: descriptor, target: self, action: #selector(filterPillClicked(_:)))
            pill.setActive(descriptor.kindValue == selectedKindFilter)
            pillButtons.append(pill)
            pillsStack.addArrangedSubview(pill)
        }

        let pillsSpacer = NSView()
        pillsSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        pillsStack.addArrangedSubview(pillsSpacer)

        let topDivider = makeDivider()

        // 3. Results scroll area
        resultsContainer.translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("ResultColumn"))
        column.resizingMask = .autoresizingMask
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.backgroundColor = .clear
        tableView.selectionHighlightStyle = .none
        tableView.rowHeight = Self.rowHeight
        tableView.intercellSpacing = NSSize(width: 0, height: 0)
        tableView.usesAutomaticRowHeights = false
        tableView.dataSource = self
        tableView.delegate = self
        tableView.target = self
        tableView.action = #selector(tableSingleClicked)
        tableView.doubleAction = #selector(tableDoubleClicked)

        scrollView.documentView = tableView
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.contentInsets = NSEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.font = NSFont.systemFont(ofSize: 13, weight: .regular)
        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.alignment = .center
        emptyLabel.isHidden = true
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        resultsContainer.addSubview(scrollView)
        resultsContainer.addSubview(emptyLabel)
        resultsContainer.isHidden = true

        // 4. Bottom divider + Footer bar
        bottomDivider.boxType = .separator
        bottomDivider.translatesAutoresizingMaskIntoConstraints = false
        bottomDivider.isHidden = true

        let footerBar = NSView()
        footerBar.translatesAutoresizingMaskIntoConstraints = false

        statusLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        shortcutButton.isBordered = false
        shortcutButton.title = HotKeyCombo.defaultCombo.label
        shortcutButton.font = NSFont.monospacedSystemFont(ofSize: 10.5, weight: .medium)
        shortcutButton.contentTintColor = .secondaryLabelColor
        shortcutButton.toolTip = "Click to change global shortcut"
        shortcutButton.wantsLayer = true
        shortcutButton.layer?.cornerRadius = 5
        shortcutButton.layer?.borderWidth = 1
        shortcutButton.layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.18).cgColor
        shortcutButton.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.06).cgColor
        shortcutButton.target = self
        shortcutButton.action = #selector(shortcutButtonClicked)
        shortcutButton.setContentHuggingPriority(.required, for: .horizontal)
        shortcutButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        shortcutButton.translatesAutoresizingMaskIntoConstraints = false

        hintsLabel.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        hintsLabel.textColor = .tertiaryLabelColor
        hintsLabel.alignment = .right
        hintsLabel.setContentHuggingPriority(.required, for: .horizontal)
        hintsLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        hintsLabel.translatesAutoresizingMaskIntoConstraints = false

        footerBar.addSubview(statusLabel)
        footerBar.addSubview(shortcutButton)
        footerBar.addSubview(hintsLabel)

        backdrop.addSubview(searchBar)
        backdrop.addSubview(pillsStack)
        backdrop.addSubview(topDivider)
        backdrop.addSubview(resultsContainer)
        backdrop.addSubview(bottomDivider)
        backdrop.addSubview(footerBar)

        NSLayoutConstraint.activate([
            // Search bar (54pt)
            searchBar.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
            searchBar.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
            searchBar.topAnchor.constraint(equalTo: backdrop.topAnchor),
            searchBar.heightAnchor.constraint(equalToConstant: 54),

            searchIcon.leadingAnchor.constraint(equalTo: searchBar.leadingAnchor, constant: 18),
            searchIcon.centerYAnchor.constraint(equalTo: searchBar.centerYAnchor),
            searchIcon.widthAnchor.constraint(equalToConstant: 20),
            searchIcon.heightAnchor.constraint(equalToConstant: 20),

            searchField.leadingAnchor.constraint(equalTo: searchIcon.trailingAnchor, constant: 12),
            searchField.trailingAnchor.constraint(equalTo: spinner.leadingAnchor, constant: -8),
            searchField.centerYAnchor.constraint(equalTo: searchBar.centerYAnchor),

            spinner.trailingAnchor.constraint(equalTo: clearButton.leadingAnchor, constant: -8),
            spinner.centerYAnchor.constraint(equalTo: searchBar.centerYAnchor),

            clearButton.trailingAnchor.constraint(equalTo: searchBar.trailingAnchor, constant: -16),
            clearButton.centerYAnchor.constraint(equalTo: searchBar.centerYAnchor),
            clearButton.widthAnchor.constraint(equalToConstant: 18),
            clearButton.heightAnchor.constraint(equalToConstant: 18),

            // Filter pills (32pt)
            pillsStack.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor, constant: 16),
            pillsStack.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor, constant: -16),
            pillsStack.topAnchor.constraint(equalTo: searchBar.bottomAnchor),
            pillsStack.heightAnchor.constraint(equalToConstant: 32),

            // Top divider (1pt)
            topDivider.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
            topDivider.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
            topDivider.topAnchor.constraint(equalTo: pillsStack.bottomAnchor),
            topDivider.heightAnchor.constraint(equalToConstant: 1),

            // Results container (fills space between topDivider and bottomDivider)
            resultsContainer.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
            resultsContainer.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
            resultsContainer.topAnchor.constraint(equalTo: topDivider.bottomAnchor),
            resultsContainer.bottomAnchor.constraint(equalTo: bottomDivider.topAnchor),

            scrollView.leadingAnchor.constraint(equalTo: resultsContainer.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: resultsContainer.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: resultsContainer.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: resultsContainer.bottomAnchor),

            emptyLabel.centerXAnchor.constraint(equalTo: resultsContainer.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: resultsContainer.centerYAnchor),

            // Bottom divider (1pt)
            bottomDivider.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
            bottomDivider.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
            bottomDivider.bottomAnchor.constraint(equalTo: footerBar.topAnchor),
            bottomDivider.heightAnchor.constraint(equalToConstant: 1),

            // Footer bar (30pt)
            footerBar.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
            footerBar.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
            footerBar.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),
            footerBar.heightAnchor.constraint(equalToConstant: 30),

            statusLabel.leadingAnchor.constraint(equalTo: footerBar.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: shortcutButton.leadingAnchor, constant: -10),
            statusLabel.centerYAnchor.constraint(equalTo: footerBar.centerYAnchor),

            shortcutButton.trailingAnchor.constraint(equalTo: hintsLabel.leadingAnchor, constant: -10),
            shortcutButton.centerYAnchor.constraint(equalTo: footerBar.centerYAnchor),
            shortcutButton.heightAnchor.constraint(equalToConstant: 20),

            hintsLabel.trailingAnchor.constraint(equalTo: footerBar.trailingAnchor, constant: -16),
            hintsLabel.centerYAnchor.constraint(equalTo: footerBar.centerYAnchor),
        ])
    }

    private func makeDivider() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.translatesAutoresizingMaskIntoConstraints = false
        return box
    }

    // MARK: - Panel Show / Hide / Positioning

    func toggle() {
        if panel.isVisible {
            dismiss(restorePreviousApp: true)
        } else {
            // Avoid reopening right after windowDidResignKey fires on a status-bar click
            if Date().timeIntervalSinceReferenceDate - lastDismissedAt < 0.2 {
                return
            }
            show()
        }
    }

    func show() {
        positionOnActiveScreen(height: targetHeight())
        NSApp.activate(ignoringOtherApps: true)
        panel.orderFrontRegardless()
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(searchField)
        if !searchField.stringValue.isEmpty {
            searchField.currentEditor()?.selectAll(nil)
        }
        refreshStatus()
    }

    func dismiss(restorePreviousApp: Bool) {
        guard panel.isVisible else { return }
        lastDismissedAt = Date().timeIntervalSinceReferenceDate
        panel.orderOut(nil)
        if restorePreviousApp {
            NSApp.hide(nil)
        }
    }

    func windowDidResignKey(_ notification: Notification) {
        lastDismissedAt = Date().timeIntervalSinceReferenceDate
        panel.orderOut(nil)
    }

    private func activeScreen() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        if let containing = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) {
            return containing
        }
        return NSScreen.main ?? NSScreen.screens.first
    }

    private func positionOnActiveScreen(height: CGFloat) {
        guard let screen = activeScreen() else { return }
        let visible = screen.visibleFrame
        let topY = visible.minY + visible.height * 0.80
        anchoredTopY = topY
        let originX = round(visible.midX - Self.panelWidth / 2)
        let originY = round(max(visible.minY + 24, topY - height))
        panel.setFrame(NSRect(x: originX, y: originY, width: Self.panelWidth, height: height), display: true)
    }

    private func targetHeight() -> CGFloat {
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return Self.collapsedHeight }
        if hits.isEmpty {
            return isWaitingForSearch ? Self.collapsedHeight : 176
        }
        let contentHeight = CGFloat(hits.count) * Self.rowHeight + 10
        return min(Self.maxExpandedHeight, max(198, Self.collapsedHeight + contentHeight))
    }

    private func updatePanelHeight() {
        let height = targetHeight()
        let showResults = height > Self.collapsedHeight + 1
        resultsContainer.isHidden = !showResults
        bottomDivider.isHidden = !showResults

        let frame = panel.frame
        guard abs(frame.height - height) > 0.5 else { return }
        let topY = anchoredTopY ?? frame.maxY
        let minAllowedY = (activeScreen()?.visibleFrame.minY ?? 24) + 24
        let newY = round(max(minAllowedY, topY - height))
        let newFrame = NSRect(x: frame.origin.x, y: newY, width: Self.panelWidth, height: height)
        panel.setFrame(newFrame, display: true, animate: false)
    }

    // MARK: - Status Bar

    func setSyncing(_ syncing: Bool) {
        isSyncingFolders = syncing
        updateStatusText()
    }

    func updateHotKeyLabel(_ label: String) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        shortcutButton.attributedTitle = NSAttributedString(
            string: " \(label) ",
            attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 10.5, weight: .medium),
                .foregroundColor: NSColor.secondaryLabelColor,
                .paragraphStyle: paragraph,
            ]
        )
        shortcutButton.toolTip = "Active shortcut: \(label) — click to change"
    }

    @objc private func shortcutButtonClicked() {
        dismiss(restorePreviousApp: false)
        onOpenShortcutPicker?()
    }

    func refreshStatus() {
        FormaSemanticBackend.shared.handleAIRequest(["action": "status"]) { [weak self] payload in
            let parsed = SpotlightStatus(dictionary: payload)
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.latestStatus = parsed
                self.updateStatusText()
            }
        }
    }

    private func updateStatusText() {
        if isSyncingFolders {
            statusLabel.stringValue = "Syncing indexed folders…"
            return
        }
        guard let st = latestStatus else {
            statusLabel.stringValue = "Ready · Forma Local Index"
            return
        }
        let docsText = numberFormatter.string(from: NSNumber(value: st.indexedDocs)) ?? "\(st.indexedDocs)"
        let docUnit = st.indexedDocs == 1 ? "doc" : "docs"
        let cleanModel = st.embedModel
            .replacingOccurrences(of: " (built-in)", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let modelLabel: String
        if st.embedOnline {
            modelLabel = st.multimodal ? "\(cleanModel) (Text + Vision)" : cleanModel
        } else {
            modelLabel = "Lexical Search"
        }
        statusLabel.stringValue = "\(docsText) \(docUnit) · \(modelLabel)"
    }

    // MARK: - Two-Stage Search (Lexical 60ms -> Hybrid Multimodal 220ms)

    @objc private func clearSearchClicked() {
        searchField.stringValue = ""
        clearButton.isHidden = true
        cancelAndClearSearch()
        panel.makeFirstResponder(searchField)
    }

    @objc private func filterPillClicked(_ sender: FilterPillButton) {
        selectedKindFilter = sender.kindValue
        for pill in pillButtons {
            pill.setActive(pill.kindValue == selectedKindFilter)
        }
        panel.makeFirstResponder(searchField)
        scheduleSearch()
    }

    func controlTextDidChange(_ obj: Notification) {
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        clearButton.isHidden = query.isEmpty
        scheduleSearch()
    }

    private func cancelAndClearSearch() {
        searchSequence &+= 1
        lexicalWorkItem?.cancel()
        hybridWorkItem?.cancel()
        lexicalWorkItem = nil
        hybridWorkItem = nil
        isWaitingForSearch = false
        spinner.stopAnimation(nil)
        hits = []
        selectedIndex = -1
        emptyLabel.isHidden = true
        tableView.reloadData()
        updatePanelHeight()
    }

    private func scheduleSearch() {
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            cancelAndClearSearch()
            return
        }

        searchSequence &+= 1
        let seq = searchSequence
        let kind = selectedKindFilter

        lexicalWorkItem?.cancel()
        hybridWorkItem?.cancel()
        isWaitingForSearch = true

        // Stage 1: Instant lexical-first pass (60ms debounce)
        let lexicalWork = DispatchWorkItem { [weak self] in
            guard let self, self.searchSequence == seq else { return }
            var req: [String: Any] = [
                "action": "semanticSearch",
                "query": query,
                "limit": 16,
                "lexicalOnly": true,
            ]
            if let kind { req["kindFilter"] = kind }
            FormaSemanticBackend.shared.handleAIRequest(req) { [weak self] payload in
                let rawHits = payload["hits"] as? [[String: Any]] ?? []
                let parsed = rawHits.compactMap(SpotlightHit.init(dictionary:))
                Task { @MainActor [weak self] in
                    guard let self, self.searchSequence == seq else { return }
                    self.applySearchResults(parsed, isFinalPass: false)
                }
            }
        }
        lexicalWorkItem = lexicalWork
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(60), execute: lexicalWork)

        // Stage 2: Full hybrid multimodal EmbeddingGemma 2 pass (220ms debounce)
        let hybridWork = DispatchWorkItem { [weak self] in
            guard let self, self.searchSequence == seq else { return }
            self.spinner.startAnimation(nil)
            var req: [String: Any] = [
                "action": "semanticSearch",
                "query": query,
                "limit": 16,
                "lexicalOnly": false,
            ]
            if let kind { req["kindFilter"] = kind }
            FormaSemanticBackend.shared.handleAIRequest(req) { [weak self] payload in
                let rawHits = payload["hits"] as? [[String: Any]] ?? []
                let parsed = rawHits.compactMap(SpotlightHit.init(dictionary:))
                Task { @MainActor [weak self] in
                    guard let self, self.searchSequence == seq else { return }
                    self.spinner.stopAnimation(nil)
                    self.applySearchResults(parsed, isFinalPass: true)
                }
            }
        }
        hybridWorkItem = hybridWork
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(220), execute: hybridWork)
    }

    private func applySearchResults(_ newHits: [SpotlightHit], isFinalPass: Bool) {
        let previousSelected: (docId: String, section: String)? = {
            guard selectedIndex >= 0, selectedIndex < hits.count else { return nil }
            let h = hits[selectedIndex]
            return (h.docId, h.sectionLabel)
        }()

        hits = newHits
        if isFinalPass {
            isWaitingForSearch = false
        } else if !newHits.isEmpty {
            isWaitingForSearch = false
        }

        if hits.isEmpty {
            selectedIndex = -1
            emptyLabel.stringValue = isFinalPass ? "No matching documents found" : "Searching with AI…"
            emptyLabel.isHidden = !isFinalPass && isWaitingForSearch
        } else {
            emptyLabel.isHidden = true
            if let prev = previousSelected,
               let preserved = hits.firstIndex(where: { $0.docId == prev.docId && $0.sectionLabel == prev.section }) {
                selectedIndex = preserved
            } else {
                selectedIndex = 0
            }
        }

        tableView.reloadData()
        if selectedIndex >= 0 {
            tableView.scrollRowToVisible(selectedIndex)
        }
        updatePanelHeight()
    }

    // MARK: - Keyboard Controls in Search Field

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        switch commandSelector {
        case #selector(NSResponder.moveDown(_:)):
            moveSelection(delta: 1)
            return true
        case #selector(NSResponder.moveUp(_:)):
            moveSelection(delta: -1)
            return true
        case #selector(NSResponder.insertNewline(_:)):
            let flags = NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
            if flags.contains(.command) {
                revealSelectedHit()
            } else {
                openSelectedHit()
            }
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            dismiss(restorePreviousApp: true)
            return true
        default:
            return false
        }
    }

    private func moveSelection(delta: Int) {
        guard !hits.isEmpty else { return }
        let oldIndex = selectedIndex
        let nextIndex: Int
        if oldIndex < 0 {
            nextIndex = delta > 0 ? 0 : hits.count - 1
        } else {
            nextIndex = max(0, min(hits.count - 1, oldIndex + delta))
        }
        guard nextIndex != oldIndex else { return }
        selectedIndex = nextIndex
        updateRowSelectionVisuals(oldIndex: oldIndex, newIndex: nextIndex)
        tableView.scrollRowToVisible(nextIndex)
    }

    private func updateRowSelectionVisuals(oldIndex: Int, newIndex: Int) {
        if oldIndex >= 0, let oldCell = tableView.view(atColumn: 0, row: oldIndex, makeIfNecessary: false) as? SpotlightResultCellView {
            oldCell.setSelectedRow(false)
        }
        if newIndex >= 0, let newCell = tableView.view(atColumn: 0, row: newIndex, makeIfNecessary: false) as? SpotlightResultCellView {
            newCell.setSelectedRow(true)
        }
    }

    // MARK: - Table DataSource & Delegate

    func numberOfRows(in tableView: NSTableView) -> Int {
        hits.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row >= 0, row < hits.count else { return nil }
        let cell = (tableView.makeView(withIdentifier: SpotlightResultCellView.reuseId, owner: self) as? SpotlightResultCellView)
            ?? {
                let v = SpotlightResultCellView()
                v.identifier = SpotlightResultCellView.reuseId
                return v
            }()
        cell.configure(hit: hits[row], selected: row == selectedIndex, homePath: homePath)
        return cell
    }

    @objc private func tableSingleClicked() {
        let row = tableView.clickedRow
        guard row >= 0, row < hits.count else { return }
        let old = selectedIndex
        selectedIndex = row
        updateRowSelectionVisuals(oldIndex: old, newIndex: row)
        panel.makeFirstResponder(searchField)
    }

    @objc private func tableDoubleClicked() {
        let row = tableView.clickedRow
        guard row >= 0, row < hits.count else { return }
        selectedIndex = row
        openSelectedHit()
    }

    // MARK: - Open / Reveal Hit Actions

    private func currentHit() -> SpotlightHit? {
        guard !hits.isEmpty else { return nil }
        let idx = (selectedIndex >= 0 && selectedIndex < hits.count) ? selectedIndex : 0
        return hits[idx]
    }

    private func openSelectedHit() {
        guard let hit = currentHit() else { return }
        dismiss(restorePreviousApp: false)

        let fm = FileManager.default
        let hasFile = !hit.path.isEmpty && fm.fileExists(atPath: hit.path)
        let descriptor = FormaKindDescriptor.descriptor(for: hit.kind)

        if hit.kind == "image" {
            if hasFile {
                NSWorkspace.shared.open(URL(fileURLWithPath: hit.path))
            }
            return
        }

        let appURL = Self.resolveFormaAppURL(appName: descriptor.appName, bundleId: descriptor.bundleId)

        if hasFile {
            let fileURL = URL(fileURLWithPath: hit.path)
            if let appURL {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = true
                NSWorkspace.shared.open([fileURL], withApplicationAt: appURL, configuration: config) { _, _ in }
            } else {
                NSWorkspace.shared.open(fileURL)
            }
        } else if let appURL {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            NSWorkspace.shared.openApplication(at: appURL, configuration: config) { _, _ in }
        }
    }

    private func revealSelectedHit() {
        guard let hit = currentHit(),
              !hit.path.isEmpty,
              FileManager.default.fileExists(atPath: hit.path) else { return }
        dismiss(restorePreviousApp: false)
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: hit.path)])
    }

    static func resolveFormaAppURL(appName: String?, bundleId: String?) -> URL? {
        let fm = FileManager.default
        if let appName {
            let direct = URL(fileURLWithPath: "/Applications/\(appName).app")
            if fm.fileExists(atPath: direct.path) {
                return direct
            }
        }
        if let bundleId, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            return url
        }
        return nil
    }
}

// MARK: - Shortcut Picker & Custom Recorder Panel

private final class ShortcutCaptureBoxView: NSView {
    var onMouseClick: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        onMouseClick?()
    }
}

@MainActor
private final class ShortcutRecorderWindowController: NSObject, NSWindowDelegate {
    private static let modifierOnlyKeyCodes: Set<UInt16> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]

    var onWillBeginRecording: (() -> Void)?
    var onApplyCombo: ((HotKeyCombo) -> Result<HotKeyCombo, ShortcutRegistrationError>)?
    var onWillClose: (() -> Void)?

    private let panel: NSPanel
    private let captureBox = ShortcutCaptureBoxView()
    private let comboLabel = NSTextField(labelWithString: "")
    private let subHintLabel = NSTextField(labelWithString: "")
    private let feedbackLabel = NSTextField(labelWithString: "")
    private var presetButtons: [(combo: HotKeyCombo, button: NSButton)] = []

    private var displayedCombo: HotKeyCombo = .defaultCombo
    private var isRecording = false
    private var eventMonitor: Any?

    override init() {
        self.panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 268),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        super.init()
        configureWindow()
        buildUI()
    }

    private func configureWindow() {
        panel.title = "Forma Search Shortcut"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.delegate = self
    }

    private func buildUI() {
        guard let content = panel.contentView else { return }

        let titleLabel = NSTextField(labelWithString: "Global Shortcut for Forma Search")
        titleLabel.font = NSFont.systemFont(ofSize: 13.5, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.translatesAutoresizingMaskIntoConstraints = false

        let subtitleLabel = NSTextField(labelWithString: "Press any shortcut with ⌘, ⌥, or ⌃ — or pick a preset below.")
        subtitleLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .regular)
        subtitleLabel.textColor = .secondaryLabelColor
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false

        captureBox.wantsLayer = true
        captureBox.layer?.cornerRadius = 10
        captureBox.layer?.borderWidth = 1.5
        captureBox.translatesAutoresizingMaskIntoConstraints = false
        captureBox.onMouseClick = { [weak self] in
            self?.beginRecording()
        }

        comboLabel.font = NSFont.monospacedSystemFont(ofSize: 22, weight: .semibold)
        comboLabel.alignment = .center
        comboLabel.translatesAutoresizingMaskIntoConstraints = false

        subHintLabel.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        subHintLabel.alignment = .center
        subHintLabel.translatesAutoresizingMaskIntoConstraints = false

        captureBox.addSubview(comboLabel)
        captureBox.addSubview(subHintLabel)

        let row1 = NSStackView()
        row1.orientation = .horizontal
        row1.alignment = .centerY
        row1.distribution = .fillEqually
        row1.spacing = 6
        row1.translatesAutoresizingMaskIntoConstraints = false

        let row2 = NSStackView()
        row2.orientation = .horizontal
        row2.alignment = .centerY
        row2.distribution = .fillEqually
        row2.spacing = 6
        row2.translatesAutoresizingMaskIntoConstraints = false

        for (idx, preset) in HotKeyCombo.presets.enumerated() {
            let btn = NSButton(title: preset.label, target: self, action: #selector(presetButtonClicked(_:)))
            btn.bezelStyle = .rounded
            btn.controlSize = .small
            btn.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
            btn.tag = idx
            presetButtons.append((combo: preset, button: btn))
            if idx < 3 {
                row1.addArrangedSubview(btn)
            } else {
                row2.addArrangedSubview(btn)
            }
        }

        let presetsStack = NSStackView(views: [row1, row2])
        presetsStack.orientation = .vertical
        presetsStack.alignment = .leading
        presetsStack.spacing = 6
        presetsStack.translatesAutoresizingMaskIntoConstraints = false

        feedbackLabel.font = NSFont.systemFont(ofSize: 11.5, weight: .medium)
        feedbackLabel.textColor = .secondaryLabelColor
        feedbackLabel.lineBreakMode = .byTruncatingTail
        feedbackLabel.maximumNumberOfLines = 1
        feedbackLabel.translatesAutoresizingMaskIntoConstraints = false

        let resetBtn = NSButton(title: "Reset Default (\(HotKeyCombo.defaultCombo.label))", target: self, action: #selector(resetClicked))
        resetBtn.bezelStyle = .rounded
        resetBtn.controlSize = .small
        resetBtn.translatesAutoresizingMaskIntoConstraints = false

        let doneBtn = NSButton(title: "Done", target: self, action: #selector(doneClicked))
        doneBtn.bezelStyle = .rounded
        doneBtn.keyEquivalent = "\r"
        doneBtn.translatesAutoresizingMaskIntoConstraints = false

        content.addSubview(titleLabel)
        content.addSubview(subtitleLabel)
        content.addSubview(captureBox)
        content.addSubview(presetsStack)
        content.addSubview(feedbackLabel)
        content.addSubview(resetBtn)
        content.addSubview(doneBtn)

        NSLayoutConstraint.activate([
            titleLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
            titleLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            titleLabel.topAnchor.constraint(equalTo: content.topAnchor, constant: 14),

            subtitleLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
            subtitleLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            subtitleLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 4),

            captureBox.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
            captureBox.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            captureBox.topAnchor.constraint(equalTo: subtitleLabel.bottomAnchor, constant: 12),
            captureBox.heightAnchor.constraint(equalToConstant: 66),

            comboLabel.centerXAnchor.constraint(equalTo: captureBox.centerXAnchor),
            comboLabel.topAnchor.constraint(equalTo: captureBox.topAnchor, constant: 10),
            comboLabel.leadingAnchor.constraint(greaterThanOrEqualTo: captureBox.leadingAnchor, constant: 12),
            comboLabel.trailingAnchor.constraint(lessThanOrEqualTo: captureBox.trailingAnchor, constant: -12),

            subHintLabel.centerXAnchor.constraint(equalTo: captureBox.centerXAnchor),
            subHintLabel.topAnchor.constraint(equalTo: comboLabel.bottomAnchor, constant: 3),

            presetsStack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
            presetsStack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            presetsStack.topAnchor.constraint(equalTo: captureBox.bottomAnchor, constant: 12),

            row1.widthAnchor.constraint(equalTo: presetsStack.widthAnchor),
            row2.widthAnchor.constraint(equalTo: presetsStack.widthAnchor),

            feedbackLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
            feedbackLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            feedbackLabel.topAnchor.constraint(equalTo: presetsStack.bottomAnchor, constant: 10),

            resetBtn.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
            resetBtn.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14),

            doneBtn.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            doneBtn.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14),
        ])
    }

    func present(currentCombo: HotKeyCombo, initialError: String? = nil) {
        displayedCombo = currentCombo
        centerOnActiveScreen()
        NSApp.activate(ignoringOtherApps: true)
        panel.orderFrontRegardless()
        panel.makeKeyAndOrderFront(nil)
        beginRecording()
        if let initialError {
            setFeedback(initialError, isError: true)
        } else {
            setFeedback("Current shortcut: \(currentCombo.label)", isError: false, neutral: true)
        }
        refreshCaptureBox(liveModifiers: nil)
    }

    func windowWillClose(_ notification: Notification) {
        stopMonitoring()
        onWillClose?()
    }

    private func centerOnActiveScreen() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else {
            panel.center()
            return
        }
        let size = panel.frame.size
        let origin = NSPoint(
            x: round(visible.midX - size.width / 2),
            y: round(visible.midY - size.height / 2 + 40)
        )
        panel.setFrameOrigin(origin)
    }

    private func beginRecording() {
        isRecording = true
        onWillBeginRecording?()
        installMonitorIfNeeded()
        refreshCaptureBox(liveModifiers: nil)
    }

    private func stopMonitoring() {
        isRecording = false
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
            eventMonitor = nil
        }
        refreshCaptureBox(liveModifiers: nil)
    }

    private func installMonitorIfNeeded() {
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { [weak self] event in
            guard let self, self.panel.isKeyWindow else { return event }
            return self.handleMonitorEvent(event) ? nil : event
        }
    }

    private func handleMonitorEvent(_ event: NSEvent) -> Bool {
        guard isRecording else { return false }

        if event.type == .flagsChanged {
            let mods = HotKeyCombo.carbonModifiers(from: event.modifierFlags)
            refreshCaptureBox(liveModifiers: mods == 0 ? nil : mods)
            return false
        }

        guard event.type == .keyDown else { return false }
        if Self.modifierOnlyKeyCodes.contains(event.keyCode) {
            return true
        }

        let mods = HotKeyCombo.carbonModifiers(from: event.modifierFlags)
        if Int(event.keyCode) == kVK_Escape && mods == 0 {
            panel.close()
            return true
        }

        guard HotKeyCombo.hasPrimaryModifier(mods) else {
            setFeedback("Include ⌘, ⌥, or ⌃ with a key", isError: true)
            refreshCaptureBox(liveModifiers: nil)
            return true
        }

        let candidate = HotKeyCombo(keyCode: UInt32(event.keyCode), carbonModifiers: mods)
        applyCandidate(candidate)
        return true
    }

    private func applyCandidate(_ candidate: HotKeyCombo) {
        guard let onApplyCombo else { return }
        switch onApplyCombo(candidate) {
        case .success(let saved):
            displayedCombo = saved
            stopMonitoring()
            setFeedback("Saved: \(saved.label)", isError: false)
            refreshCaptureBox(liveModifiers: nil)
        case .failure(let err):
            setFeedback(err.userMessage, isError: true)
            beginRecording()
        }
    }

    @objc private func presetButtonClicked(_ sender: NSButton) {
        guard sender.tag >= 0, sender.tag < HotKeyCombo.presets.count else { return }
        applyCandidate(HotKeyCombo.presets[sender.tag])
    }

    @objc private func resetClicked() {
        applyCandidate(.defaultCombo)
    }

    @objc private func doneClicked() {
        panel.close()
    }

    private func setFeedback(_ text: String, isError: Bool, neutral: Bool = false) {
        feedbackLabel.stringValue = text
        if neutral {
            feedbackLabel.textColor = .secondaryLabelColor
        } else {
            feedbackLabel.textColor = isError ? .systemRed : .systemGreen
        }
    }

    private func refreshCaptureBox(liveModifiers: UInt32?) {
        if let liveModifiers, liveModifiers != 0 {
            comboLabel.stringValue = HotKeyCombo.modifierSymbols(for: liveModifiers) + "…"
            comboLabel.textColor = .controlAccentColor
            subHintLabel.stringValue = "Release modifier or press a key"
            subHintLabel.textColor = .controlAccentColor
        } else if isRecording {
            comboLabel.stringValue = displayedCombo.label
            comboLabel.textColor = .labelColor
            subHintLabel.stringValue = "Listening… Press keys"
            subHintLabel.textColor = .controlAccentColor
        } else {
            comboLabel.stringValue = displayedCombo.label
            comboLabel.textColor = .labelColor
            subHintLabel.stringValue = "Click here to record a custom shortcut"
            subHintLabel.textColor = .secondaryLabelColor
        }

        captureBox.effectiveAppearance.performAsCurrentDrawingAppearance {
            if isRecording {
                captureBox.layer?.borderColor = NSColor.controlAccentColor.withAlphaComponent(0.85).cgColor
                captureBox.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(0.08).cgColor
            } else {
                captureBox.layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.18).cgColor
                captureBox.layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.04).cgColor
            }
        }

        for entry in presetButtons {
            let active = entry.combo == displayedCombo
            entry.button.contentTintColor = active ? .controlAccentColor : nil
        }
    }
}

// MARK: - App Delegate (Menu Bar Agent + Global Shortcut)

@MainActor
private final class FormaSpotlightAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private let statusMenu = NSMenu()
    private var searchMenuItem: NSMenuItem?
    private var shortcutSubmenuItem: NSMenuItem?
    private var presetMenuItems: [(combo: HotKeyCombo, item: NSMenuItem)] = []
    private var syncMenuItem: NSMenuItem?
    private var controller: FormaSpotlightController?
    private var recorderController: ShortcutRecorderWindowController?

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private var signalSources: [DispatchSourceSignal] = []
    private var isSyncing = false
    private var activeCombo: HotKeyCombo = .defaultCombo

    func applicationDidFinishLaunching(_ notification: Notification) {
        installEditMenu()
        let spotlight = FormaSpotlightController()
        spotlight.onOpenShortcutPicker = { [weak self] in
            self?.openShortcutRecorder()
        }
        controller = spotlight

        installHotKeyEventHandler()
        registerInitialGlobalHotKey()
        setupStatusBar()
        updateShortcutUI()
        installSignalHandlers()

        if !ProcessInfo.processInfo.arguments.contains("--background") {
            controller?.show()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controller?.show()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        unregisterGlobalHotKey()
        for source in signalSources { source.cancel() }
        signalSources.removeAll()
        FormaSemanticBackend.shared.shutdown()
    }

    func togglePanel() {
        controller?.toggle()
    }

    // MARK: - Minimal Hidden Main Menu (Enables ⌘C/⌘V/⌘X/⌘A/⌘Z in Search Field)

    private func installEditMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Forma Search", action: #selector(quitClicked), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Status Bar & Context Menu

    private func setupStatusBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            if let symbol = NSImage(systemSymbolName: "magnifyingglass.circle.fill", accessibilityDescription: "Forma Search") {
                symbol.isTemplate = true
                button.image = symbol
            } else {
                button.title = "F"
            }
            button.toolTip = "Forma Search (\(activeCombo.label))"
            button.target = self
            button.action = #selector(statusBarClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item

        statusMenu.delegate = self
        statusMenu.autoenablesItems = false

        let searchItem = NSMenuItem(title: "Search Forma (\(activeCombo.label))", action: #selector(openSearchClicked), keyEquivalent: "")
        searchItem.target = self
        statusMenu.addItem(searchItem)
        searchMenuItem = searchItem

        let shortcutRoot = NSMenuItem(title: "Shortcut (\(activeCombo.label))", action: nil, keyEquivalent: "")
        let shortcutMenu = NSMenu(title: "Shortcut")
        presetMenuItems.removeAll()
        for (idx, preset) in HotKeyCombo.presets.enumerated() {
            let presetItem = NSMenuItem(title: preset.label, action: #selector(selectPresetShortcutClicked(_:)), keyEquivalent: "")
            presetItem.target = self
            presetItem.tag = idx
            shortcutMenu.addItem(presetItem)
            presetMenuItems.append((combo: preset, item: presetItem))
        }
        shortcutMenu.addItem(.separator())
        let customItem = NSMenuItem(title: "Record Custom Shortcut…", action: #selector(recordCustomShortcutClicked), keyEquivalent: "")
        customItem.target = self
        shortcutMenu.addItem(customItem)
        shortcutRoot.submenu = shortcutMenu
        statusMenu.addItem(shortcutRoot)
        shortcutSubmenuItem = shortcutRoot

        statusMenu.addItem(.separator())

        let syncItem = NSMenuItem(title: "Sync Indexed Folders Now", action: #selector(syncNowClicked), keyEquivalent: "")
        syncItem.target = self
        statusMenu.addItem(syncItem)
        syncMenuItem = syncItem

        statusMenu.addItem(.separator())

        let apps: [(title: String, appName: String, bundleId: String)] = [
            ("Open Forma Docs", "Forma Docs", "com.formaoffice.docs"),
            ("Open Forma Sheets", "Forma Sheets", "com.formaoffice.sheets"),
            ("Open Forma Slides", "Forma Slides", "com.formaoffice.slides"),
            ("Open Forma PDF", "Forma PDF", "com.formaoffice.pdf"),
            ("Open Forma Lab", "Forma Lab", "com.formaoffice.lab"),
            ("Open Forma Canvas", "Forma Canvas", "com.formaoffice.canvas"),
        ]
        for entry in apps {
            let menuItem = NSMenuItem(title: entry.title, action: #selector(openFormaAppClicked(_:)), keyEquivalent: "")
            menuItem.target = self
            menuItem.representedObject = [entry.appName, entry.bundleId]
            statusMenu.addItem(menuItem)
        }

        statusMenu.addItem(.separator())

        let quitItem = NSMenuItem(title: "Quit Forma Search", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self
        statusMenu.addItem(quitItem)
    }

    @objc private func statusBarClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        let isContextClick = event?.type == .rightMouseUp
            || (event?.modifierFlags.contains(.control) == true)
        if isContextClick {
            statusItem?.menu = statusMenu
            statusItem?.button?.performClick(nil)
        } else {
            togglePanel()
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        if menu === statusMenu {
            statusItem?.menu = nil
        }
    }

    @objc private func openSearchClicked() {
        controller?.show()
    }

    @objc private func selectPresetShortcutClicked(_ sender: NSMenuItem) {
        guard sender.tag >= 0, sender.tag < HotKeyCombo.presets.count else { return }
        let chosen = HotKeyCombo.presets[sender.tag]
        switch applyShortcut(chosen) {
        case .success:
            break
        case .failure(let err):
            openShortcutRecorder(initialError: err.userMessage)
        }
    }

    @objc private func recordCustomShortcutClicked() {
        openShortcutRecorder()
    }

    private func openShortcutRecorder(initialError: String? = nil) {
        let recorder = recorderController ?? {
            let vc = ShortcutRecorderWindowController()
            vc.onWillBeginRecording = { [weak self] in
                self?.suspendActiveHotKey()
            }
            vc.onApplyCombo = { [weak self] combo in
                guard let self else { return .failure(.eventHandlerMissing) }
                return self.applyShortcut(combo)
            }
            vc.onWillClose = { [weak self] in
                self?.restoreActiveHotKeyIfNeeded()
            }
            return vc
        }()
        recorderController = recorder
        recorder.present(currentCombo: activeCombo, initialError: initialError)
    }

    private func updateShortcutUI() {
        let label = activeCombo.label
        statusItem?.button?.toolTip = "Forma Search (\(label))"
        searchMenuItem?.title = "Search Forma (\(label))"
        shortcutSubmenuItem?.title = "Shortcut (\(label))"
        for entry in presetMenuItems {
            entry.item.state = (entry.combo == activeCombo) ? .on : .off
        }
        controller?.updateHotKeyLabel(label)
    }

    @objc private func syncNowClicked() {
        guard !isSyncing else { return }
        isSyncing = true
        syncMenuItem?.title = "Syncing Indexed Folders…"
        syncMenuItem?.isEnabled = false
        controller?.setSyncing(true)

        FormaSemanticBackend.shared.handleAIRequest(["action": "syncWatchedFolders", "force": false]) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.isSyncing = false
                self.syncMenuItem?.title = "Sync Indexed Folders Now"
                self.syncMenuItem?.isEnabled = true
                self.controller?.setSyncing(false)
                self.controller?.refreshStatus()
            }
        }
    }

    @objc private func openFormaAppClicked(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String], info.count == 2 else { return }
        guard let url = FormaSpotlightController.resolveFormaAppURL(appName: info[0], bundleId: info[1]) else {
            NSSound.beep()
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in }
    }

    @objc private func quitClicked() {
        NSApp.terminate(nil)
    }

    // MARK: - Carbon Global Hotkey (Saved / Default + Live Rebinding)

    private func installHotKeyEventHandler() {
        guard eventHandlerRef == nil else { return }
        var eventSpec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let userData = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            formaHotKeyHandler,
            1,
            &eventSpec,
            userData,
            &eventHandlerRef
        )
        if installStatus != noErr {
            fputs("[FormaSearch] InstallEventHandler failed with OSStatus \(installStatus)\n", stderr)
            fflush(stderr)
        }
    }

    @discardableResult
    private func registerHotKey(_ combo: HotKeyCombo) -> OSStatus {
        suspendActiveHotKey()
        let hotKeyID = EventHotKeyID(signature: formaHotKeySignature, id: formaHotKeyId)
        var candidateRef: EventHotKeyRef?
        let status = RegisterEventHotKey(
            combo.keyCode,
            combo.normalizedModifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &candidateRef
        )
        if status == noErr, let candidateRef {
            hotKeyRef = candidateRef
        }
        return status
    }

    private func suspendActiveHotKey() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
    }

    private func restoreActiveHotKeyIfNeeded() {
        guard hotKeyRef == nil else { return }
        if registerHotKey(activeCombo) == noErr {
            updateShortcutUI()
        }
    }

    private func registerInitialGlobalHotKey() {
        var candidates: [HotKeyCombo] = []
        if let saved = HotKeyCombo.loadSaved() {
            candidates.append(saved)
        }
        let fallbacks: [HotKeyCombo] = [
            HotKeyCombo(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(controlKey)),
            HotKeyCombo(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(optionKey | shiftKey)),
            HotKeyCombo(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(controlKey | optionKey)),
            HotKeyCombo(keyCode: UInt32(kVK_ANSI_F), carbonModifiers: UInt32(optionKey)),
            HotKeyCombo(keyCode: UInt32(kVK_Space), carbonModifiers: UInt32(optionKey)),
        ]
        for fb in fallbacks where !candidates.contains(fb) {
            candidates.append(fb)
        }

        for candidate in candidates {
            let status = registerHotKey(candidate)
            if status == noErr {
                activeCombo = candidate
                fputs("[FormaSearch] Registered global hotkey \(candidate.label)\n", stderr)
                fflush(stderr)
                return
            }
            fputs("[FormaSearch] Hotkey \(candidate.label) unavailable (OSStatus \(status))\n", stderr)
            fflush(stderr)
        }
    }

    private func applyShortcut(_ combo: HotKeyCombo) -> Result<HotKeyCombo, ShortcutRegistrationError> {
        guard eventHandlerRef != nil else {
            return .failure(.eventHandlerMissing)
        }
        let previous = activeCombo
        let status = registerHotKey(combo)
        if status == noErr {
            activeCombo = combo
            combo.save()
            fputs("[FormaSearch] Registered global hotkey \(combo.label)\n", stderr)
            fflush(stderr)
            updateShortcutUI()
            return .success(combo)
        }
        fputs("[FormaSearch] Hotkey \(combo.label) unavailable (OSStatus \(status))\n", stderr)
        fflush(stderr)
        _ = registerHotKey(previous)
        return .failure(.conflict(combo: combo, status: status))
    }

    private func unregisterGlobalHotKey() {
        suspendActiveHotKey()
        if let handler = eventHandlerRef {
            RemoveEventHandler(handler)
            eventHandlerRef = nil
        }
    }

    // MARK: - Graceful Signal Handling (launchctl bootout / SIGTERM)

    private func installSignalHandlers() {
        signalSources = [SIGINT, SIGTERM].map { code in
            Darwin.signal(code, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
            source.setEventHandler {
                NSApp.terminate(nil)
            }
            source.resume()
            return source
        }
    }
}

// MARK: - Entry Point

@main
@MainActor
struct FormaSpotlightMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = FormaSpotlightAppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}
