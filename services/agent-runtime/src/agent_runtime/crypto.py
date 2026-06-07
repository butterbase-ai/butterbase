"""AES-256-GCM encrypt/decrypt.

Wire format matches services/control-api/src/services/crypto.ts:
    base64(iv) : base64(ciphertext) : base64(authTag)

where iv = 12 random bytes (96-bit GCM nonce) and authTag = 16 bytes.
Key must be 32 bytes (pass bytes.fromhex(hex64) for the 64-hex-char env var).
"""

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def encrypt(plaintext: str, key: bytes) -> str:
    """Encrypt *plaintext* and return ``iv:ciphertext:authTag`` (all base64)."""
    iv = os.urandom(12)
    aesgcm = AESGCM(key)
    # AESGCM.encrypt returns ciphertext || tag (tag appended)
    ct_and_tag = aesgcm.encrypt(iv, plaintext.encode("utf-8"), None)
    ct = ct_and_tag[:-16]
    tag = ct_and_tag[-16:]
    return (
        base64.b64encode(iv).decode()
        + ":"
        + base64.b64encode(ct).decode()
        + ":"
        + base64.b64encode(tag).decode()
    )


def decrypt(blob: str, key: bytes) -> str:
    """Decrypt a ``iv:ciphertext:authTag`` blob and return the plaintext."""
    iv_b64, ct_b64, tag_b64 = blob.split(":")
    iv = base64.b64decode(iv_b64)
    ct = base64.b64decode(ct_b64)
    tag = base64.b64decode(tag_b64)
    aesgcm = AESGCM(key)
    # AESGCM.decrypt expects ciphertext || tag concatenated
    plaintext_bytes = aesgcm.decrypt(iv, ct + tag, None)
    return plaintext_bytes.decode("utf-8")
