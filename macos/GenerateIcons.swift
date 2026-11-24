import Cocoa

// Generates crisp macOS squircle App Icons (.iconset PNGs) for Forma Sheets & Forma Docs.
// Usage: swift macos/GenerateIcons.swift <sheets|docs> <output_iconset_dir>

guard CommandLine.arguments.count >= 3 else {
    fputs("Usage: GenerateIcons.swift <sheets|docs> <output_iconset_dir>\n", stderr)
    exit(1)
}

let kind = CommandLine.arguments[1]
let outDir = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

func renderIcon(size: Int, kind: String) -> NSBitmapImageRep {
    let s = CGFloat(size)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: size,
        pixelsHigh: size,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    rep.size = NSSize(width: s, height: s)

    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    let cg = ctx.cgContext

    // macOS icon padding (~10% inset)
    let inset = s * 0.085
    let cardRect = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
    let radius = cardRect.width * 0.225
    let cardPath = NSBezierPath(roundedRect: cardRect, xRadius: radius, yRadius: radius)

    // Subtle drop shadow
    cg.saveGState()
    cg.setShadow(offset: CGSize(width: 0, height: -s * 0.015), blur: s * 0.035, color: NSColor.black.withAlphaComponent(0.28).cgColor)
    NSColor.white.setFill()
    cardPath.fill()
    cg.restoreGState()

    // Gradient background fill
    cg.saveGState()
    cardPath.addClip()
    let colors: [CGColor]
    if kind == "sheets" {
        colors = [
            NSColor(calibratedRed: 0.02, green: 0.59, blue: 0.41, alpha: 1.0).cgColor,
            NSColor(calibratedRed: 0.04, green: 0.36, blue: 0.28, alpha: 1.0).cgColor,
        ]
    } else if kind == "slides" {
        colors = [
            NSColor(calibratedRed: 0.96, green: 0.52, blue: 0.08, alpha: 1.0).cgColor,
            NSColor(calibratedRed: 0.76, green: 0.25, blue: 0.05, alpha: 1.0).cgColor,
        ]
    } else if kind == "pdf" {
        colors = [
            NSColor(calibratedRed: 0.90, green: 0.14, blue: 0.28, alpha: 1.0).cgColor,
            NSColor(calibratedRed: 0.58, green: 0.05, blue: 0.17, alpha: 1.0).cgColor,
        ]
    } else if kind == "lab" {
        colors = [
            NSColor(calibratedRed: 0.52, green: 0.24, blue: 0.95, alpha: 1.0).cgColor,
            NSColor(calibratedRed: 0.22, green: 0.16, blue: 0.64, alpha: 1.0).cgColor,
        ]
    } else if kind == "canvas" {
        colors = [
            NSColor(calibratedRed: 0.04, green: 0.72, blue: 0.84, alpha: 1.0).cgColor,
            NSColor(calibratedRed: 0.05, green: 0.44, blue: 0.58, alpha: 1.0).cgColor,
        ]
    } else if kind == "search" {
        colors = [
            NSColor(calibratedRed: 0.25, green: 0.34, blue: 0.92, alpha: 1.0).cgColor,
            NSColor(calibratedRed: 0.11, green: 0.14, blue: 0.36, alpha: 1.0).cgColor,
        ]
    } else {
        colors = [
            NSColor(calibratedRed: 0.15, green: 0.48, blue: 0.96, alpha: 1.0).cgColor,
            NSColor(calibratedRed: 0.11, green: 0.25, blue: 0.69, alpha: 1.0).cgColor,
        ]
    }
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0.0, 1.0])!
    cg.drawLinearGradient(
        gradient,
        start: CGPoint(x: cardRect.minX, y: cardRect.maxY),
        end: CGPoint(x: cardRect.maxX, y: cardRect.minY),
        options: []
    )

    // Top soft radial glow
    let glowColors = [NSColor.white.withAlphaComponent(0.22).cgColor, NSColor.white.withAlphaComponent(0.0).cgColor] as CFArray
    let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: glowColors, locations: [0, 1])!
    cg.drawRadialGradient(
        glow,
        startCenter: CGPoint(x: s * 0.32, y: s * 0.78),
        startRadius: 0,
        endCenter: CGPoint(x: s * 0.32, y: s * 0.78),
        endRadius: s * 0.65,
        options: []
    )

    // Inner white floating sheet/page card
    let innerW = cardRect.width * 0.66
    let innerH = cardRect.height * 0.68
    let innerRect = CGRect(
        x: cardRect.midX - innerW / 2,
        y: cardRect.midY - innerH / 2,
        width: innerW,
        height: innerH
    )
    let innerRadius = innerW * 0.10
    let innerPath = NSBezierPath(roundedRect: innerRect, xRadius: innerRadius, yRadius: innerRadius)

    cg.saveGState()
    cg.setShadow(offset: CGSize(width: 0, height: -s * 0.014), blur: s * 0.03, color: NSColor.black.withAlphaComponent(0.22).cgColor)
    NSColor.white.withAlphaComponent(0.96).setFill()
    innerPath.fill()
    cg.restoreGState()

    if kind == "sheets" {
        // Draw crisp spreadsheet table header + 3x3 grid cells + green highlight cell
        let pad = innerW * 0.10
        let gridRect = innerRect.insetBy(dx: pad, dy: pad)
        let rows = 4
        let cols = 3
        let cellW = gridRect.width / CGFloat(cols)
        let cellH = gridRect.height / CGFloat(rows)

        // Header row accent (top row in AppKit coordinates is y = maxY - cellH)
        let hdrRect = CGRect(x: gridRect.minX, y: gridRect.maxY - cellH, width: gridRect.width, height: cellH)
        let hdrPath = NSBezierPath(roundedRect: hdrRect, xRadius: s * 0.015, yRadius: s * 0.015)
        NSColor(calibratedRed: 0.06, green: 0.72, blue: 0.50, alpha: 0.25).setFill()
        hdrPath.fill()

        // Active selected cell highlight
        let activeRect = CGRect(x: gridRect.minX + cellW, y: gridRect.maxY - cellH * 2, width: cellW, height: cellH)
        NSColor(calibratedRed: 0.02, green: 0.59, blue: 0.41, alpha: 0.18).setFill()
        NSBezierPath(rect: activeRect).fill()

        // Grid strokes
        NSColor(calibratedRed: 0.04, green: 0.42, blue: 0.31, alpha: 0.35).setStroke()
        let border = NSBezierPath(roundedRect: gridRect, xRadius: s * 0.015, yRadius: s * 0.015)
        border.lineWidth = max(1, s * 0.012)
        border.stroke()

        for c in 1..<cols {
            let x = gridRect.minX + CGFloat(c) * cellW
            let line = NSBezierPath()
            line.move(to: CGPoint(x: x, y: gridRect.minY))
            line.line(to: CGPoint(x: x, y: gridRect.maxY))
            line.lineWidth = max(1, s * 0.010)
            line.stroke()
        }
        for r in 1..<rows {
            let y = gridRect.minY + CGFloat(r) * cellH
            let line = NSBezierPath()
            line.move(to: CGPoint(x: gridRect.minX, y: y))
            line.line(to: CGPoint(x: gridRect.maxX, y: y))
            line.lineWidth = max(1, s * 0.010)
            line.stroke()
        }

        // Crisp focus border on active cell
        NSColor(calibratedRed: 0.02, green: 0.59, blue: 0.41, alpha: 1.0).setStroke()
        let focus = NSBezierPath(rect: activeRect)
        focus.lineWidth = max(1.5, s * 0.016)
        focus.stroke()
    } else if kind == "slides" {
        // Widescreen presentation slide card with orange title accent + 3 chart bars
        let slideW = cardRect.width * 0.74
        let slideH = slideW * 0.62
        let slideRect = CGRect(
            x: cardRect.midX - slideW / 2,
            y: cardRect.midY - slideH / 2 + s * 0.02,
            width: slideW,
            height: slideH
        )
        let padX = slideW * 0.11
        let padY = slideH * 0.14
        let titleH = max(2, slideH * 0.14)
        let titleRect = CGRect(x: slideRect.minX + padX, y: slideRect.maxY - padY - titleH, width: slideW * 0.56, height: titleH)
        NSColor(calibratedRed: 0.92, green: 0.38, blue: 0.05, alpha: 0.95).setFill()
        NSBezierPath(roundedRect: titleRect, xRadius: titleH * 0.35, yRadius: titleH * 0.35).fill()

        // 3 ascending chart bars inside slide
        let barBaseY = slideRect.minY + padY
        let barAreaW = slideW - padX * 2
        let barW = barAreaW * 0.22
        let gap = barAreaW * 0.08
        let heights: [CGFloat] = [slideH * 0.24, slideH * 0.40, slideH * 0.54]
        let barColors = [
            NSColor(calibratedRed: 0.98, green: 0.72, blue: 0.20, alpha: 0.90),
            NSColor(calibratedRed: 0.95, green: 0.48, blue: 0.10, alpha: 0.95),
            NSColor(calibratedRed: 0.80, green: 0.25, blue: 0.05, alpha: 0.95),
        ]
        for i in 0..<3 {
            let bx = slideRect.minX + padX + CGFloat(i) * (barW + gap) + barAreaW * 0.08
            let br = CGRect(x: bx, y: barBaseY, width: barW, height: heights[i])
            barColors[i].setFill()
            NSBezierPath(roundedRect: br, xRadius: s * 0.014, yRadius: s * 0.014).fill()
        }
    } else if kind == "pdf" {
        // Draw crisp crimson PDF ribbon badge + stylized document lines
        let padX = innerW * 0.12
        let padY = innerH * 0.12
        let contentW = innerW - padX * 2

        // Crimson PDF pill banner across upper portion of page
        let bannerH = innerH * 0.28
        let bannerRect = CGRect(
            x: innerRect.minX + padX * 0.5,
            y: innerRect.maxY - padY - bannerH,
            width: innerW - padX,
            height: bannerH
        )
        NSColor(calibratedRed: 0.88, green: 0.11, blue: 0.28, alpha: 1.0).setFill()
        NSBezierPath(roundedRect: bannerRect, xRadius: bannerH * 0.28, yRadius: bannerH * 0.28).fill()

        // Crisp "PDF" text centered inside the crimson banner
        let fontSize = bannerH * 0.56
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .heavy),
            .foregroundColor: NSColor.white,
        ]
        let label = NSAttributedString(string: "PDF", attributes: attrs)
        let textSize = label.size()
        let textPt = CGPoint(
            x: bannerRect.midX - textSize.width / 2,
            y: bannerRect.midY - textSize.height / 2
        )
        label.draw(at: textPt)

        // Subtle document lines + highlighter bar below banner
        let lineH = max(1.5, innerH * 0.052)
        let widths: [CGFloat] = [0.95, 0.82, 0.90, 0.58]
        for (idx, wFrac) in widths.enumerated() {
            let y = bannerRect.minY - innerH * 0.10 - CGFloat(idx) * (lineH * 2.2)
            if y < innerRect.minY + padY { break }
            let r = CGRect(x: innerRect.minX + padX, y: y - lineH, width: contentW * wFrac, height: lineH)
            if idx == 1 {
                NSColor(calibratedRed: 0.99, green: 0.88, blue: 0.28, alpha: 0.85).setFill()
            } else {
                NSColor(calibratedRed: 0.20, green: 0.25, blue: 0.33, alpha: 0.32).setFill()
            }
            NSBezierPath(roundedRect: r, xRadius: lineH * 0.45, yRadius: lineH * 0.45).fill()
        }
    } else if kind == "lab" {
        // Reimagined Notebook Studio icon: markdown heading + dark code cell + plotted output curve
        let padX = innerW * 0.11
        let padY = innerH * 0.11
        let contentW = innerW - padX * 2

        // Top Markdown heading bar + violet spark dot
        let h1H = max(2, innerH * 0.09)
        let topY = innerRect.maxY - padY
        let dotR = h1H * 0.55
        let dotRect = CGRect(x: innerRect.minX + padX, y: topY - h1H, width: dotR * 2, height: dotR * 2)
        NSColor(calibratedRed: 0.49, green: 0.23, blue: 0.93, alpha: 1.0).setFill()
        NSBezierPath(ovalIn: dotRect).fill()

        let h1Rect = CGRect(
            x: innerRect.minX + padX + dotR * 2.5,
            y: topY - h1H,
            width: contentW - dotR * 2.5 - contentW * 0.12,
            height: h1H
        )
        NSColor(calibratedRed: 0.43, green: 0.20, blue: 0.85, alpha: 0.88).setFill()
        NSBezierPath(roundedRect: h1Rect, xRadius: h1H * 0.4, yRadius: h1H * 0.4).fill()

        // Dark code cell container in middle
        let codeH = innerH * 0.34
        let codeRect = CGRect(
            x: innerRect.minX + padX,
            y: topY - h1H - innerH * 0.09 - codeH,
            width: contentW,
            height: codeH
        )
        NSColor(calibratedRed: 0.08, green: 0.10, blue: 0.18, alpha: 0.96).setFill()
        NSBezierPath(roundedRect: codeRect, xRadius: s * 0.018, yRadius: s * 0.018).fill()

        // 3 crisp syntax-colored code bars inside code cell
        let cPadX = codeRect.width * 0.10
        let cLineH = max(1.5, codeH * 0.15)
        let codeLines: [(CGFloat, NSColor)] = [
            (0.62, NSColor(calibratedRed: 0.66, green: 0.55, blue: 0.98, alpha: 0.95)),
            (0.78, NSColor(calibratedRed: 0.20, green: 0.83, blue: 0.60, alpha: 0.95)),
            (0.45, NSColor(calibratedRed: 0.98, green: 0.75, blue: 0.14, alpha: 0.95)),
        ]
        for (idx, item) in codeLines.enumerated() {
            let ly = codeRect.maxY - codeH * 0.24 - CGFloat(idx) * (cLineH * 1.85)
            let lr = CGRect(
                x: codeRect.minX + cPadX,
                y: ly - cLineH / 2,
                width: (codeRect.width - cPadX * 2) * item.0,
                height: cLineH
            )
            item.1.setFill()
            NSBezierPath(roundedRect: lr, xRadius: cLineH * 0.45, yRadius: cLineH * 0.45).fill()
        }

        // Output plot area at bottom with smooth gradient-descent curve
        let plotRect = CGRect(
            x: innerRect.minX + padX,
            y: innerRect.minY + padY,
            width: contentW,
            height: max(4, codeRect.minY - innerRect.minY - padY - innerH * 0.08)
        )
        NSColor(calibratedRed: 0.49, green: 0.23, blue: 0.93, alpha: 0.09).setFill()
        NSBezierPath(roundedRect: plotRect, xRadius: s * 0.015, yRadius: s * 0.015).fill()

        let curve = NSBezierPath()
        curve.move(to: CGPoint(x: plotRect.minX + plotRect.width * 0.08, y: plotRect.maxY - plotRect.height * 0.18))
        curve.curve(
            to: CGPoint(x: plotRect.maxX - plotRect.width * 0.08, y: plotRect.minY + plotRect.height * 0.22),
            controlPoint1: CGPoint(x: plotRect.minX + plotRect.width * 0.34, y: plotRect.minY + plotRect.height * 0.24),
            controlPoint2: CGPoint(x: plotRect.minX + plotRect.width * 0.62, y: plotRect.minY + plotRect.height * 0.22)
        )
        NSColor(calibratedRed: 0.49, green: 0.23, blue: 0.93, alpha: 0.95).setStroke()
        curve.lineWidth = max(1.5, s * 0.022)
        curve.lineCapStyle = .round
        curve.stroke()
    } else if kind == "canvas" {
        // Draw crisp dotted whiteboard + cyan node + yellow sticky note + curved connector arrow
        let padX = innerW * 0.11
        let padY = innerH * 0.11
        let contentW = innerW - padX * 2
        let contentH = innerH - padY * 2

        // Subtle whiteboard dot grid
        NSColor(calibratedRed: 0.55, green: 0.64, blue: 0.72, alpha: 0.35).setFill()
        let dotR = max(0.8, s * 0.008)
        for gx in 0..<5 {
            for gy in 0..<5 {
                let dx = innerRect.minX + padX + (contentW * CGFloat(gx) / 4.0)
                let dy = innerRect.minY + padY + (contentH * CGFloat(gy) / 4.0)
                NSBezierPath(ovalIn: CGRect(x: dx - dotR, y: dy - dotR, width: dotR * 2, height: dotR * 2)).fill()
            }
        }

        // Top-left cyan architecture card
        let node1 = CGRect(
            x: innerRect.minX + padX * 0.9,
            y: innerRect.maxY - padY - contentH * 0.36,
            width: contentW * 0.46,
            height: contentH * 0.34
        )
        NSColor(calibratedRed: 0.04, green: 0.65, blue: 0.78, alpha: 0.92).setFill()
        NSBezierPath(roundedRect: node1, xRadius: s * 0.022, yRadius: s * 0.022).fill()

        // Bottom-right warm sticky note
        let sticky = CGRect(
            x: innerRect.maxX - padX * 0.9 - contentW * 0.46,
            y: innerRect.minY + padY * 0.9,
            width: contentW * 0.46,
            height: contentH * 0.40
        )
        NSColor(calibratedRed: 0.99, green: 0.83, blue: 0.30, alpha: 0.96).setFill()
        NSBezierPath(roundedRect: sticky, xRadius: s * 0.018, yRadius: s * 0.018).fill()

        // Smooth connector arrow between node1 and sticky
        let arrow = NSBezierPath()
        let p0 = CGPoint(x: node1.maxX, y: node1.midY)
        let p1 = CGPoint(x: sticky.midX, y: sticky.maxY)
        arrow.move(to: p0)
        arrow.curve(
            to: p1,
            controlPoint1: CGPoint(x: p1.x, y: p0.y),
            controlPoint2: CGPoint(x: p1.x, y: p1.y + contentH * 0.14)
        )
        NSColor(calibratedRed: 0.07, green: 0.22, blue: 0.34, alpha: 0.88).setStroke()
        arrow.lineWidth = max(1.5, s * 0.022)
        arrow.lineCapStyle = .round
        arrow.stroke()

        // Arrowhead
        let ah = max(2.5, s * 0.036)
        let head = NSBezierPath()
        head.move(to: CGPoint(x: p1.x - ah * 0.75, y: p1.y + ah))
        head.line(to: p1)
        head.line(to: CGPoint(x: p1.x + ah * 0.75, y: p1.y + ah))
        head.lineWidth = max(1.5, s * 0.022)
        head.lineCapStyle = .round
        head.lineJoinStyle = .round
        head.stroke()
    } else if kind == "search" {
        // Draw crisp Spotlight-style magnifying glass + semantic sparkle dot
        let lensRadius = min(innerW, innerH) * 0.23
        let lensCenter = CGPoint(x: innerRect.midX - innerW * 0.06, y: innerRect.midY + innerH * 0.06)
        let lensRect = CGRect(
            x: lensCenter.x - lensRadius,
            y: lensCenter.y - lensRadius,
            width: lensRadius * 2,
            height: lensRadius * 2
        )

        // Subtle indigo tint inside lens
        NSColor(calibratedRed: 0.30, green: 0.42, blue: 0.96, alpha: 0.14).setFill()
        NSBezierPath(ovalIn: lensRect).fill()

        // Magnifying glass ring
        let ring = NSBezierPath(ovalIn: lensRect)
        NSColor(calibratedRed: 0.22, green: 0.31, blue: 0.88, alpha: 0.95).setStroke()
        ring.lineWidth = max(2.0, s * 0.042)
        ring.stroke()

        // Magnifying glass handle
        let handle = NSBezierPath()
        let angle = -CGFloat.pi / 4.0
        let startPt = CGPoint(
            x: lensCenter.x + cos(angle) * lensRadius * 1.05,
            y: lensCenter.y + sin(angle) * lensRadius * 1.05
        )
        let endPt = CGPoint(
            x: lensCenter.x + cos(angle) * (lensRadius * 2.05),
            y: lensCenter.y + sin(angle) * (lensRadius * 2.05)
        )
        handle.move(to: startPt)
        handle.line(to: endPt)
        handle.lineWidth = max(2.4, s * 0.052)
        handle.lineCapStyle = .round
        handle.stroke()

        // Semantic accent spark inside lens
        let sparkR = lensRadius * 0.28
        let spark = NSBezierPath(ovalIn: CGRect(
            x: lensCenter.x - sparkR,
            y: lensCenter.y - sparkR,
            width: sparkR * 2,
            height: sparkR * 2
        ))
        NSColor(calibratedRed: 0.06, green: 0.72, blue: 0.84, alpha: 0.92).setFill()
        spark.fill()
    } else {
        // Draw crisp document heading bar + paragraph lines + accent callout bar
        let padX = innerW * 0.13
        let padY = innerH * 0.13
        let contentW = innerW - padX * 2
        let topY = innerRect.maxY - padY

        // Heading bar
        let h1H = max(2, innerH * 0.095)
        let h1Rect = CGRect(x: innerRect.minX + padX, y: topY - h1H, width: contentW * 0.68, height: h1H)
        NSColor(calibratedRed: 0.14, green: 0.39, blue: 0.92, alpha: 0.92).setFill()
        NSBezierPath(roundedRect: h1Rect, xRadius: h1H * 0.35, yRadius: h1H * 0.35).fill()

        // Body lines
        let lineH = max(1.5, innerH * 0.048)
        let widths: [CGFloat] = [1.0, 0.92, 0.78, 0.96, 0.85, 0.62]
        for (idx, wFrac) in widths.enumerated() {
            let y = topY - h1H - innerH * 0.11 - CGFloat(idx) * (lineH * 2.15)
            if y < innerRect.minY + padY { break }
            let r = CGRect(x: innerRect.minX + padX, y: y - lineH, width: contentW * wFrac, height: lineH)
            NSColor(calibratedRed: 0.20, green: 0.25, blue: 0.33, alpha: idx < 3 ? 0.42 : 0.28).setFill()
            NSBezierPath(roundedRect: r, xRadius: lineH * 0.45, yRadius: lineH * 0.45).fill()
        }
    }

    // Subtle inner rim highlight on outer squircle
    cg.restoreGState()
    NSColor.white.withAlphaComponent(0.28).setStroke()
    cardPath.lineWidth = max(1, s * 0.008)
    cardPath.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let specs: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for (filename, px) in specs {
    let rep = renderIcon(size: px, kind: kind)
    guard let png = rep.representation(using: .png, properties: [:]) else { continue }
    try png.write(to: outDir.appendingPathComponent(filename))
}
print("Generated \(kind) iconset at \(outDir.path)")
