/** @jest-environment node */
import path from "node:path"
import { getPrebuildConfigAsync } from "@expo/prebuild-config"
import { compileModsAsync } from "expo/config-plugins"

const projectRoot = path.resolve(__dirname, "../..")

describe("app.json", () => {
    // Checked on the resolved manifest, not app.json: if another plugin sets backup rules first,
    // expo-secure-store skips its own with only a prebuild warning.
    it("keeps SecureStore out of Android cloud backup and device transfer", async () => {
        const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms: ["android"] })
        const resolved = await compileModsAsync(exp, {
            projectRoot,
            introspect: true,
            platforms: ["android"],
            assertMissingModProviders: false
        })

        const application = resolved._internal?.modResults.android.manifest.manifest.application[0].$
        expect(application["android:fullBackupContent"]).toBe("@xml/secure_store_backup_rules")
        expect(application["android:dataExtractionRules"]).toBe("@xml/secure_store_data_extraction_rules")
    })
})
