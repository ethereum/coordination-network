import type { JSX, ReactNode } from "react"
import { StyleSheet, Text, View } from "react-native"
import { useTheme } from "../tokens"
import type { Brand } from "../tokens"

export interface CardProps {
    title?: string
    /**
     * The issuing member's own colours: a stripe down the edge and a tint behind `header`. A stripe
     * alone reads as a plain white card from any distance, which is no use to a room watching one.
     * The body stays on `surface`, because the fields under it are read off the screen and are
     * contrast-checked against paper rather than against a tint.
     */
    brand?: Brand
    /** The row that names the record. Drawn in the brand's tint, when there is one. */
    header?: ReactNode
    /** A record the network has cancelled: washed with the danger colour, over the brand's own
     *  colours rather than in place of them - whose credential it is outlives its cancellation. */
    voided?: boolean
    children: ReactNode
}

const STRIPE_WIDTH = 6

/** A surface panel: the base container for a screen's grouped content. */
export default function Card({ title, brand, header, voided = false, children }: CardProps): JSX.Element {
    const theme = useTheme()
    // A voided card with no brand still needs to read as cancelled from its edge, so danger stands
    // in only when there is no issuer's colour to carry.
    const stripe = brand?.accent ?? (voided ? theme.colors.danger : undefined)

    return (
        <View
            style={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.line,
                borderWidth: 1,
                borderLeftWidth: stripe ? STRIPE_WIDTH : undefined,
                borderLeftColor: stripe,
                borderRadius: theme.radii.md,
                borderCurve: "continuous",
                overflow: "hidden"
            }}
        >
            {header ? (
                <View
                    style={{
                        backgroundColor: brand?.accentSoft ?? theme.colors.canvas,
                        paddingHorizontal: theme.spacing.lg,
                        paddingVertical: theme.spacing.md,
                        borderBottomWidth: 1,
                        borderBottomColor: theme.colors.rule
                    }}
                >
                    {header}
                </View>
            ) : null}
            <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
                {title ? (
                    <Text
                        style={{
                            ...theme.type.md,
                            fontWeight: "600",
                            fontFamily: theme.face("600"),
                            color: theme.colors.ink
                        }}
                    >
                        {title}
                    </Text>
                ) : null}
                {children}
            </View>
            {/* Last, so it lies over the header's own tint as well as the body - a wash under an
                opaque band would not reach it. A translucent layer rather than an alpha suffix on
                the colour string, so it works whatever format `danger` is in, as `Badge` does. */}
            {voided ? (
                <View
                    pointerEvents="none"
                    style={{ ...StyleSheet.absoluteFillObject, backgroundColor: theme.colors.danger, opacity: 0.06 }}
                />
            ) : null}
        </View>
    )
}
