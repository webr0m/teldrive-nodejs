// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(name: "AparajitaCapacitorSecureStorage", path: "../../../../node_modules/.pnpm/@aparajita+capacitor-secure-storage@8.0.1/node_modules/@aparajita/capacitor-secure-storage"),
        .package(name: "CapacitorCommunityAdmob", path: "../../../../node_modules/.pnpm/@capacitor-community+admob@8.2.1/node_modules/@capacitor-community/admob"),
        .package(name: "CapacitorApp", path: "../../../../node_modules/.pnpm/@capacitor+app@8.1.2_@capacitor+core@8.5.3/node_modules/@capacitor/app"),
        .package(name: "CapacitorBrowser", path: "../../../../node_modules/.pnpm/@capacitor+browser@8.0.5_@capacitor+core@8.5.3/node_modules/@capacitor/browser"),
        .package(name: "CapacitorFileTransfer", path: "../../../../node_modules/.pnpm/@capacitor+file-transfer@2.0.6_@capacitor+core@8.5.3/node_modules/@capacitor/file-transfer"),
        .package(name: "CapacitorFilesystem", path: "../../../../node_modules/.pnpm/@capacitor+filesystem@8.1.4_@capacitor+core@8.5.3/node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorShare", path: "../../../../node_modules/.pnpm/@capacitor+share@8.0.3_@capacitor+core@8.5.3/node_modules/@capacitor/share")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "AparajitaCapacitorSecureStorage", package: "AparajitaCapacitorSecureStorage"),
                .product(name: "CapacitorCommunityAdmob", package: "CapacitorCommunityAdmob"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorFileTransfer", package: "CapacitorFileTransfer"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorShare", package: "CapacitorShare")
            ]
        )
    ]
)
