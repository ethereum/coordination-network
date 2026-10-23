import { useMemo } from "react"
import { View } from "react-native"
import qrcode from "qrcode-generator"

/** Native Views keep this QR independent of browser canvas and additional native modules. */
export default function PresentationQr({ value }: { value: string }) {
    const rows = useMemo(() => {
        const code = qrcode(0, "M")
        code.addData(value, "Byte")
        code.make()
        const count = code.getModuleCount()
        return Array.from({ length: count }, (_, row) => {
            const runs: { start: number; length: number }[] = []
            for (let column = 0; column < count;) {
                if (!code.isDark(row, column)) {
                    column++
                    continue
                }
                const start = column
                while (column < count && code.isDark(row, column)) column++
                runs.push({ start, length: column - start })
            }
            return runs
        })
    }, [value])
    const moduleSize = Math.max(2, Math.floor(300 / (rows.length + 8)))
    const size = moduleSize * (rows.length + 8)
    return (
        <View
            testID="presentation-qr"
            accessible
            accessibilityLabel="Presentation challenge QR"
            style={{ width: size, height: size, backgroundColor: "white", alignSelf: "center" }}
        >
            {rows.flatMap((runs, row) =>
                runs.map(({ start, length }) => (
                    <View
                        key={`${row}-${start}`}
                        style={{
                            position: "absolute",
                            left: (start + 4) * moduleSize,
                            top: (row + 4) * moduleSize,
                            width: length * moduleSize,
                            height: moduleSize,
                            backgroundColor: "black"
                        }}
                    />
                ))
            )}
        </View>
    )
}
