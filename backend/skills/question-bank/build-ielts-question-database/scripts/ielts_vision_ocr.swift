#!/usr/bin/swift
// macOS Vision OCR 回退：输入一张 PNG/JPEG，标准输出为 OCR 文本。
// Python 解析器只在 Tesseract 不可用或无结果时调用本脚本。
import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count >= 2 else {
    fputs("用法: ielts_vision_ocr.swift <image>\n", stderr)
    exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("无法读取图像\n", stderr)
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US"]
let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { observation in
        observation.topCandidates(1).first?.string
    }
    print(lines.joined(separator: "\n"))
} catch {
    fputs("Vision OCR 错误: \(error)\n", stderr)
    exit(4)
}
