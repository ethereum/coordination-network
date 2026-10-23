import { spawnSync } from "child_process"
import { createHash } from "crypto"
import {
    chmodSync,
    copyFileSync,
    existsSync,
    symlinkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, it, expect } from "@jest/globals"

const SCRIPTS_DIR = join(__dirname, "..", "scripts")

const CARGO_TOML = (version: string) => `[package]
name = "noir-prover-native"
version = "${version}"
edition = "2021"

[dependencies.foo]
version = "9.9.9"
features = ["bar"]

[workspace.package]
version = "8.8.8"
`

/**
 * The scripts resolve everything relative to their own location, so each test copies them into a
 * throwaway package tree and never touches the real jniLibs.
 */
describe("android library scripts", () => {
    let pkg: string
    let jniLibs: string
    let bindings: string

    const SO = "arm64-v8a/libnoir_prover_native.so"
    const GENERATED = ["src/generated/noir_prover_native.ts", "cpp/generated/noir_prover_native.cpp"]
    const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

    // Records the fixture tree the way package-android-libs.sh does, so each test starts from a pass.
    const recordHashes = () =>
        writeFileSync(
            join(pkg, "rust", "android-libs.sha256"),
            [`jniLibs/${SO}`, ...GENERATED]
                .map((rel) => {
                    const path = rel.startsWith("jniLibs/") ? join(jniLibs, SO) : join(bindings, rel)
                    const shown = rel.startsWith("jniLibs/")
                        ? join("MoproReactNativeBindings/android/src/main/jniLibs", SO)
                        : join("MoproReactNativeBindings", rel)
                    return `${sha256(path)}  ${shown}\n`
                })
                .join("")
        )

    const writeCargo = (version: string) => writeFileSync(join(pkg, "rust", "Cargo.toml"), CARGO_TOML(version))
    const writeSo = () => writeFileSync(join(jniLibs, "arm64-v8a", "libnoir_prover_native.so"), "dummy")
    const writeMarker = (version: string) => writeFileSync(join(jniLibs, "VERSION"), `${version}\n`)
    const run = (script: string, env: NodeJS.ProcessEnv = process.env) =>
        spawnSync("bash", [join(pkg, "scripts", script)], { encoding: "utf8", env })

    beforeEach(() => {
        pkg = mkdtempSync(join(tmpdir(), "noir-android-libs-"))
        bindings = join(pkg, "rust", "MoproReactNativeBindings")
        jniLibs = join(bindings, "android", "src", "main", "jniLibs")
        mkdirSync(join(jniLibs, "arm64-v8a"), { recursive: true })
        for (const rel of GENERATED) {
            mkdirSync(join(bindings, rel, ".."), { recursive: true })
            writeFileSync(join(bindings, rel), `generated ${rel}`)
        }
        mkdirSync(join(pkg, "scripts"))
        for (const script of ["check-android-libs.sh", "fetch-android-libs.sh"]) {
            copyFileSync(join(SCRIPTS_DIR, script), join(pkg, "scripts", script))
        }
        writeCargo("0.1.0")
        writeSo()
        recordHashes()
        rmSync(join(jniLibs, "arm64-v8a", "libnoir_prover_native.so"))
    })

    afterEach(() => {
        rmSync(pkg, { recursive: true, force: true })
    })

    describe("check-android-libs.sh", () => {
        it("passes when the library is present, VERSION matches and every hash matches", () => {
            writeSo()
            writeMarker("0.1.0")

            expect(run("check-android-libs.sh").status).toBe(0)
        })

        it("fails when the library is missing, naming it and the fetch script", () => {
            writeMarker("0.1.0")

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("arm64-v8a/libnoir_prover_native.so")
            expect(result.stderr).toContain("fetch-android-libs.sh")
        })

        it("fails when VERSION is missing", () => {
            writeSo()

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("none")
        })

        it("fails when VERSION is for another crate version, naming both", () => {
            writeSo()
            writeMarker("0.0.9")

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("0.0.9")
            expect(result.stderr).toContain("0.1.0")
        })

        it("fails when the library differs from the recorded hash", () => {
            writeSo()
            writeMarker("0.1.0")
            writeFileSync(join(jniLibs, SO), "rebuilt")

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("libnoir_prover_native.so")
            expect(result.stderr).toContain("android-libs.sha256")
        })

        it("fails when jniLibs holds an extra ABI directory", () => {
            writeSo()
            writeMarker("0.1.0")
            mkdirSync(join(jniLibs, "x86_64"))
            writeFileSync(join(jniLibs, "x86_64", "libnoir_prover_native.so"), "unverified")

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("x86_64")
        })

        it("fails when arm64-v8a holds an extra file", () => {
            writeSo()
            writeMarker("0.1.0")
            writeFileSync(join(jniLibs, "arm64-v8a", "libother.so"), "unverified")

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("libother.so")
        })

        it("fails when the library is a symlink", () => {
            writeMarker("0.1.0")
            writeFileSync(join(pkg, "real.so"), "dummy")
            symlinkSync(join(pkg, "real.so"), join(jniLibs, SO))

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("regular files")
        })

        it("fails when a generated binding differs from the recorded hash", () => {
            writeSo()
            writeMarker("0.1.0")
            writeFileSync(join(bindings, GENERATED[0]), "regenerated")

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain(GENERATED[0])
        })

        it("fails when the hash file does not list the library", () => {
            writeSo()
            writeMarker("0.1.0")
            const file = join(pkg, "rust", "android-libs.sha256")
            const lines = readFileSync(file, "utf8")
                .split("\n")
                .filter((l) => l && !l.includes(".so"))
            writeFileSync(file, `${lines.join("\n")}\n`)

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("must list exactly")
        })

        it("fails when a generated file has no line in the hash file", () => {
            writeSo()
            writeMarker("0.1.0")
            writeFileSync(join(bindings, "src", "generated", "extra.ts"), "new")

            const result = run("check-android-libs.sh")

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("must list exactly")
        })

        it("fails when the hash file has a line that is not a hash", () => {
            writeSo()
            writeMarker("0.1.0")
            const file = join(pkg, "rust", "android-libs.sha256")
            writeFileSync(file, `${readFileSync(file, "utf8")}not a hash line\n`)

            expect(run("check-android-libs.sh").status).not.toBe(0)
        })

        it("neither lists nor trips over a stray .DS_Store in generated/", () => {
            writeSo()
            writeMarker("0.1.0")
            writeFileSync(join(bindings, "src", "generated", ".DS_Store"), "finder")

            expect(run("check-android-libs.sh").status).toBe(0)
        })

        it("takes the first top-level version line, which is [package]'s, over later tables", () => {
            writeSo()
            writeMarker("9.9.9")

            expect(run("check-android-libs.sh").status).not.toBe(0)

            writeMarker("8.8.8")
            expect(run("check-android-libs.sh").status).not.toBe(0)
        })
    })

    describe("package-android-libs.sh", () => {
        let home: string
        let env: NodeJS.ProcessEnv

        const target = () => join(pkg, "rust", "target", "aarch64-linux-android", "release")

        beforeEach(() => {
            home = join(pkg, "home")
            mkdirSync(home)
            copyFileSync(join(SCRIPTS_DIR, "package-android-libs.sh"), join(pkg, "scripts", "package-android-libs.sh"))
            const nmDir = join(pkg, "ndk", "toolchains", "llvm", "prebuilt", "any", "bin")
            mkdirSync(nmDir, { recursive: true })
            writeFileSync(join(nmDir, "llvm-nm"), "#!/usr/bin/env bash\n")
            chmodSync(join(nmDir, "llvm-nm"), 0o755)
            mkdirSync(target(), { recursive: true })
            writeFileSync(join(target(), "libnoir_prover_native.so"), "dummy")
            spawnSync("git", ["init", "--quiet", pkg])
            env = { ...process.env, HOME: home, ANDROID_NDK_HOME: join(pkg, "ndk") }
        })

        it("pins the library and generated files but not dotfiles, and packs only named members", () => {
            writeFileSync(join(bindings, "src", "generated", ".DS_Store"), "finder")

            const result = run("package-android-libs.sh", env)

            expect(result.status).toBe(0)
            const pinned = readFileSync(join(pkg, "rust", "android-libs.sha256"), "utf8")
            expect(pinned).toContain("libnoir_prover_native.so")
            expect(pinned).toContain("src/generated/noir_prover_native.ts")
            expect(pinned).not.toContain(".DS_Store")
            const listing = spawnSync("tar", ["-tzf", join(pkg, "noir-prover-native-android-v0.1.0.tar.gz")], {
                encoding: "utf8"
            }).stdout
            expect(listing).toContain("jniLibs/VERSION")
            expect(listing).not.toContain("._")
        })

        it("refuses a library that contains the home directory", () => {
            writeFileSync(join(target(), "libnoir_prover_native.so"), `panic at ${home}/.cargo/src/lib.rs`)

            const result = run("package-android-libs.sh", env)

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("path remap")
        })
    })

    describe("fetch-android-libs.sh", () => {
        const main = () => join(bindings, "android", "src", "main")

        // Builds the release asset: jniLibs/ plus whatever extra members a test wants in the archive.
        // An extra member under jniLibs/ is also named explicitly, as an AppleDouble ._ entry would be.
        const makeArchive = (opts: { so?: string | null; version?: string | null; extra?: string[] } = {}) => {
            const stage = mkdtempSync(join(pkg, "stage-"))
            mkdirSync(join(stage, "jniLibs", "arm64-v8a"), { recursive: true })
            if (opts.so !== null) writeFileSync(join(stage, "jniLibs", SO), opts.so ?? "dummy")
            if (opts.version !== null) writeFileSync(join(stage, "jniLibs", "VERSION"), `${opts.version ?? "0.1.0"}\n`)
            for (const extra of opts.extra ?? []) {
                mkdirSync(join(stage, extra, ".."), { recursive: true })
                writeFileSync(join(stage, extra), "planted")
            }
            const archive = join(pkg, "asset.tar.gz")
            // Members are named as package-android-libs.sh does, so they carry no leading ./ that GNU tar
            // would not match by name.
            spawnSync("tar", [
                "-czf",
                archive,
                "-C",
                stage,
                "jniLibs",
                ...(opts.extra ?? []).filter((e) => !e.startsWith("jniLibs/"))
            ])
            return archive
        }

        // A stub gh records its arguments and streams the archive, so no network is used.
        const fetchWith = (archive: string, version = "0.1.0") => {
            const bin = join(pkg, "bin")
            mkdirSync(bin, { recursive: true })
            writeFileSync(
                join(bin, "gh"),
                `#!/usr/bin/env bash
echo "$@" > "${join(pkg, "gh-args")}"
cat "${archive}"
`
            )
            chmodSync(join(bin, "gh"), 0o755)
            writeCargo(version)
            return run("fetch-android-libs.sh", { ...process.env, PATH: `${bin}:${process.env.PATH}` })
        }

        it("requests the release tag and asset for the crate version, and unpacks a valid archive", () => {
            const result = fetchWith(makeArchive(), "0.1.0")

            expect(result.status).toBe(0)
            const args = readFileSync(join(pkg, "gh-args"), "utf8")
            expect(args).toContain("noir-prover-native-v0.1.0")
            expect(args).toContain("noir-prover-native-android-v0.1.0.tar.gz")
            expect(readFileSync(join(jniLibs, "VERSION"), "utf8")).toBe("0.1.0\n")
        })

        it("extracts only jniLibs, so an archive cannot overwrite tracked sources", () => {
            const result = fetchWith(makeArchive({ extra: ["java/com/moproffi/MoproFfiModule.kt"] }))

            expect(result.status).toBe(0)
            expect(existsSync(join(main(), "java", "com", "moproffi", "MoproFfiModule.kt"))).toBe(false)
        })

        it("ignores AppleDouble and other extra members, and the check still passes", () => {
            const result = fetchWith(
                makeArchive({
                    extra: ["jniLibs/._VERSION", "jniLibs/arm64-v8a/._libnoir_prover_native.so", "._jniLibs"]
                })
            )

            expect(result.status).toBe(0)
            expect(existsSync(join(jniLibs, "._VERSION"))).toBe(false)
            expect(existsSync(join(jniLibs, "arm64-v8a", "._libnoir_prover_native.so"))).toBe(false)
            expect(existsSync(join(main(), "._jniLibs"))).toBe(false)
        })

        it("fails on a truncated archive and leaves no jniLibs", () => {
            const archive = makeArchive()
            const bytes = readFileSync(archive)
            writeFileSync(archive, bytes.subarray(0, bytes.length - 20))

            const result = fetchWith(archive)

            expect(result.status).not.toBe(0)
            expect(existsSync(join(main(), "jniLibs"))).toBe(false)
        })

        it("re-downloads when VERSION matches but the library was tampered with", () => {
            writeSo()
            writeMarker("0.1.0")
            writeFileSync(join(jniLibs, SO), "tampered")

            const result = fetchWith(makeArchive())

            expect(result.status).toBe(0)
            expect(readFileSync(join(jniLibs, SO), "utf8")).toBe("dummy")
        })

        it("fails when the archive lacks the library", () => {
            const result = fetchWith(makeArchive({ so: null }))

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("arm64-v8a/libnoir_prover_native.so")
        })

        it("fails when the archive lacks VERSION", () => {
            const result = fetchWith(makeArchive({ version: null }))

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("jniLibs/VERSION")
        })

        it("fails on a library with the wrong hash, and discards it", () => {
            const result = fetchWith(makeArchive({ so: "tampered" }))

            expect(result.status).not.toBe(0)
            expect(result.stderr).toContain("android-libs.sha256")
            expect(existsSync(join(jniLibs, "VERSION"))).toBe(false)
        })

        it("skips the download when VERSION matches and the check passes", () => {
            writeSo()
            writeMarker("0.1.0")

            const result = run("fetch-android-libs.sh", { ...process.env, PATH: "/usr/bin:/bin" })

            expect(result.status).toBe(0)
            expect(result.stdout).toContain("already present")
        })
    })
})
