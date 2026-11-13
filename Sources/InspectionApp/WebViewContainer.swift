import SwiftUI
import WebKit

struct WebViewContainer: NSViewRepresentable {
    let url: URL?
    let onCreated: (WKWebView) -> Void

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = false
        webView.customUserAgent = "InspectionAssistant/1.0 (\(webView.customUserAgent ?? ""))"
        onCreated(webView)
        if let url { webView.load(URLRequest(url: url)) }
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard let url else { return }
        if webView.url != url {
            webView.load(URLRequest(url: url))
        }
    }
}
