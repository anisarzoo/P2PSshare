import SwiftUI
import WebKit

struct WebContainerView: UIViewRepresentable {
    func makeCoordinator() -> NativeBridgeCoordinator {
        NativeBridgeCoordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()

        let bootstrapBridge = """
        window.NativeP2PBridge = {
            postMessage: function(payload) {
                window.webkit.messageHandlers.NativeP2PBridge.postMessage(payload);
            }
        };
        """

        contentController.addUserScript(
            WKUserScript(
                source: bootstrapBridge,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
        )

        contentController.add(context.coordinator, name: "NativeP2PBridge")

        config.userContentController = contentController
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        context.coordinator.webView = webView

        if let localUrl = Bundle.main.url(forResource: "index", withExtension: "html") {
            webView.loadFileURL(localUrl, allowingReadAccessTo: localUrl.deletingLastPathComponent())
        } else if let remoteUrl = URL(string: "https://connectvia.netlify.app") {
            webView.load(URLRequest(url: remoteUrl))
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
    }
}
