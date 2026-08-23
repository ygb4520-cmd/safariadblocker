//
//  ViewController.swift
//  Ad Tracker Blocker
//
//  Minimal SwiftUI content view for the container app. All it needs to do
//  is send the user to Safari's Extensions preferences -- the extension
//  itself is configured from its own toolbar popup once enabled there.
//

import SwiftUI
import SafariServices

let extensionBundleIdentifier = "org.yasw.adtrackerblocker.Extension"

struct ContentView: View {
    @State private var stateDescription = "Checking extension state…"

    var body: some View {
        VStack(spacing: 16) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .frame(width: 96, height: 96)

            Text("Ad & Tracker Blocker")
                .font(.title2)
                .bold()

            Text(stateDescription)
                .font(.body)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 320)

            Button("Open Safari Extensions Preferences…") {
                openSafariPreferences()
            }
            .keyboardShortcut(.defaultAction)

            Text("In Safari, turn on “Ad & Tracker Blocker” under Extensions. Once enabled, click its toolbar icon to switch Ads, Trackers, and Custom rules on or off, pause blocking on the current site, or add your own blocking patterns.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 320)
        }
        .padding(32)
        .frame(width: 380, height: 360)
        .onAppear(perform: refreshState)
    }

    private func refreshState() {
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            DispatchQueue.main.async {
                guard let state, error == nil else {
                    stateDescription = "Couldn’t determine extension state. Open Safari Extensions preferences to check."
                    return
                }
                stateDescription = state.isEnabled
                    ? "The extension is currently ON."
                    : "The extension is currently OFF. Enable it below."
            }
        }
    }

    private func openSafariPreferences() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
    }
}

#Preview {
    ContentView()
}
