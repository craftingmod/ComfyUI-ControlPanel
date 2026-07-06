def manager_cache_key_hash(value: str) -> int:
    """Return the 32-bit rolling hash used by Manager cache filenames."""
    acc = 0
    for codepoint in map(ord, value):
        acc = ((acc << 5) - acc + codepoint) & 0xFFFF_FFFF
    return acc