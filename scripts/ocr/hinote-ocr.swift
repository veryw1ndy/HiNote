// hinote-ocr: read the words in an image with Apple's Vision framework (the
// same engine as Live Text), offline. HiNote runs this once per image and
// lays the words over the picture so they can be selected and highlighted.
//
//   hinote-ocr <image>   ->  JSON on stdout
//   {"width":W,"height":H,"dark":bool,"lines":[{"tokens":[{"t":"word","x":..,"y":..,"w":..,"h":..}]}]}
//
// Boxes are in image pixels, origin top-left. A token is a word; in Chinese,
// Japanese and Korean text, where there are no spaces, each character is one.

import Foundation
import Vision
import CoreGraphics
import ImageIO

struct Token: Codable { let t: String; let x: Double; let y: Double; let w: Double; let h: Double }
struct Line: Codable { let tokens: [Token] }
struct Output: Codable { let width: Int; let height: Int; let dark: Bool; let lines: [Line] }

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func isCJK(_ c: Character) -> Bool {
    guard let v = c.unicodeScalars.first?.value else { return false }
    return (0x3000...0x303F).contains(v) || (0x3040...0x30FF).contains(v) || (0x3400...0x4DBF).contains(v)
        || (0x4E00...0x9FFF).contains(v) || (0xAC00...0xD7AF).contains(v) || (0xFF00...0xFFEF).contains(v)
}

/// Mostly dark image (dark-mode screenshot)? Then a highlight has to lighten, not darken.
func isDark(_ image: CGImage) -> Bool {
    let n = 16
    var pixels = [UInt8](repeating: 0, count: n * n)
    let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
        guard let ctx = CGContext(data: buffer.baseAddress, width: n, height: n, bitsPerComponent: 8,
                                  bytesPerRow: n, space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        // transparent parts show the (light) note page behind them
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: n, height: n))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: n, height: n))
        return true
    }
    guard drawn else { return false }
    return pixels.reduce(0) { $0 + Int($1) } / (n * n) < 110
}

let args = CommandLine.arguments
guard args.count == 2 else { fail("usage: hinote-ocr <image>") }

let url = URL(fileURLWithPath: args[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("cannot read image: \(args[1])") }

let width = Double(image.width), height = Double(image.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US", "zh-Hans"]
if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    fail("text recognition failed: \(error)")
}

var lines: [Line] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let s = candidate.string
    var tokens: [Token] = []
    var i = s.startIndex
    while i < s.endIndex {
        if s[i].isWhitespace { i = s.index(after: i); continue }
        var j = s.index(after: i)
        if !isCJK(s[i]) {
            while j < s.endIndex && !s[j].isWhitespace && !isCJK(s[j]) { j = s.index(after: j) }
        }
        // Vision boxes are normalised with the origin bottom-left
        if let box = try? candidate.boundingBox(for: i..<j)?.boundingBox {
            tokens.append(Token(t: String(s[i..<j]),
                                x: box.minX * width, y: (1 - box.maxY) * height,
                                w: box.width * width, h: box.height * height))
        }
        i = j
    }
    if !tokens.isEmpty { lines.append(Line(tokens: tokens)) }
}

let output = Output(width: image.width, height: image.height, dark: isDark(image), lines: lines)
FileHandle.standardOutput.write(try! JSONEncoder().encode(output))
