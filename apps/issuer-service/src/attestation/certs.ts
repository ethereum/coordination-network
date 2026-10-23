import { X509Certificate } from "node:crypto"
import { id_ce_keyDescription } from "@peculiar/asn1-android"
import { AsnConvert } from "@peculiar/asn1-schema"
import { Certificate } from "@peculiar/asn1-x509"

export interface DecodedCert {
    x509: X509Certificate
    asn: Certificate
    /** Lowercase hex without leading zeros, as the status list keys it. */
    serialHex: string
    /** Subject attribute values by OID. */
    subject: ReadonlyMap<string, readonly string[]>
    /** Values of every KeyDescription extension on this cert. */
    keyDescriptions: ArrayBuffer[]
}

/** Throws unless `der` is exactly one DER certificate. */
export function decodeCert(der: Buffer): DecodedCert {
    const x509 = new X509Certificate(der)
    // OpenSSL also takes PEM and stops at the end of the first certificate; the ASN.1 reads
    // below must see the same bytes it verified.
    if (!x509.raw.equals(der)) throw new Error("not a single DER certificate")
    const asn = AsnConvert.parse(der, Certificate)

    const subject = new Map<string, string[]>()
    for (const rdn of asn.tbsCertificate.subject) {
        for (const { type, value } of rdn) {
            subject.set(type, [...(subject.get(type) ?? []), value.toString()])
        }
    }
    return {
        x509,
        asn,
        serialHex: BigInt(`0x${Buffer.from(asn.tbsCertificate.serialNumber).toString("hex")}`).toString(16),
        subject,
        keyDescriptions: (asn.tbsCertificate.extensions ?? [])
            .filter(({ extnID }) => extnID === id_ce_keyDescription)
            .map(({ extnValue }) => extnValue.buffer)
    }
}
