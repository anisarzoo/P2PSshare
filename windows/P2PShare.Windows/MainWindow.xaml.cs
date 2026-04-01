using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using P2PShare.Windows.Services;

namespace P2PShare.Windows;

public partial class MainWindow : Window
{
    private readonly NativeBridgeService _nativeBridgeService = new();

    public MainWindow()
    {
        InitializeComponent();
        Loaded += MainWindowOnLoaded;
    }

    private async void MainWindowOnLoaded(object sender, RoutedEventArgs e)
    {
        await Browser.EnsureCoreWebView2Async();

        Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
        Browser.CoreWebView2.Settings.AreDevToolsEnabled = true;
        Browser.CoreWebView2.Settings.IsStatusBarEnabled = false;

        Browser.CoreWebView2.WebMessageReceived += CoreWebView2OnWebMessageReceived;

        await Browser.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
            "window.NativeP2PBridge = { postMessage: function(payload) { window.chrome.webview.postMessage(payload); } };"
        );

        var localIndex = Path.Combine(AppContext.BaseDirectory, "Assets", "Web", "index.html");

        if (File.Exists(localIndex))
        {
            Browser.Source = new Uri(localIndex);
        }
        else
        {
            Browser.Source = new Uri("https://connectvia.netlify.app");
        }
    }

    private async void CoreWebView2OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var rawPayload = e.TryGetWebMessageAsString();
        var action = ExtractAction(rawPayload);

        var response = _nativeBridgeService.HandleAction(action);
        var json = JsonSerializer.Serialize(response);

        await Browser.CoreWebView2.ExecuteScriptAsync($"window.handleNativeBridgeMessage({json});");
    }

    private static string? ExtractAction(string? payload)
    {
        if (string.IsNullOrWhiteSpace(payload))
        {
            return null;
        }

        try
        {
            using var json = JsonDocument.Parse(payload);
            if (json.RootElement.TryGetProperty("action", out var actionElement))
            {
                return actionElement.GetString();
            }
        }
        catch
        {
            return null;
        }

        return null;
    }
}
