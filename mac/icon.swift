// Draws the app icon: a dark rounded tile with a terminal prompt and accent bar.
import Cocoa
let out = CommandLine.arguments[1]
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let s = CGFloat(size)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = s * 0.09
    let tile = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    NSColor(calibratedRed: 0.13, green: 0.13, blue: 0.13, alpha: 1).setFill()
    NSBezierPath(roundedRect: tile, xRadius: s * 0.19, yRadius: s * 0.19).fill()
    NSColor(calibratedRed: 0.22, green: 0.22, blue: 0.22, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: inset + s * 0.08, y: inset + s * 0.09, width: s * 0.17, height: s * 0.64), xRadius: s * 0.04, yRadius: s * 0.04).fill()
    let p = NSBezierPath()
    p.lineWidth = s * 0.06
    p.lineCapStyle = .round
    p.lineJoinStyle = .round
    p.move(to: NSPoint(x: s * 0.44, y: s * 0.64))
    p.line(to: NSPoint(x: s * 0.58, y: s * 0.5))
    p.line(to: NSPoint(x: s * 0.44, y: s * 0.36))
    NSColor(calibratedRed: 0.85, green: 0.47, blue: 0.34, alpha: 1).setStroke()
    p.stroke()
    let u = NSBezierPath()
    u.lineWidth = s * 0.06
    u.lineCapStyle = .round
    u.move(to: NSPoint(x: s * 0.62, y: s * 0.34))
    u.line(to: NSPoint(x: s * 0.76, y: s * 0.34))
    NSColor(calibratedWhite: 0.9, alpha: 1).setStroke()
    u.stroke()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(size).png"))
}
