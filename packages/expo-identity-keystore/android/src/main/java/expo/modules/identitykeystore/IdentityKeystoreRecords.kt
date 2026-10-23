package expo.modules.identitykeystore

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.records.Required
import expo.modules.kotlin.types.Enumerable

enum class KeyPurpose(val value: String) : Enumerable {
  SIGN("sign"),
  AGREE("agree")
}

class GenerateKeyOptions : Record {
  @Field
  @Required
  val purpose: KeyPurpose = KeyPurpose.SIGN

  /** Base64, at most 128 bytes. Makes Keystore attest the key; see `getAttestationChain`. */
  @Field
  val attestationChallenge: String? = null
}

/** Text of the system authentication dialog. */
class PromptOptions : Record {
  @Field
  @Required
  val title: String = ""

  @Field
  val subtitle: String? = null
}
