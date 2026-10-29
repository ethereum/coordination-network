"""Flattens a Prover.toml into the harness witness: the circuit's parameters depth-first in ABI
order, each value a decimal string. This is the initial witness `prove_ultra_honk` solves from,
not the solved witness `nargo execute` writes.

The ABI type tree sets the order and the array lengths, so a struct's fields come out in ABI
order whatever order Prover.toml lists them in."""
import json
import sys
import tomllib


def scalar(value):
    number = int(value, 0) if isinstance(value, str) else int(value)
    if number < 0:
        raise SystemExit(f"negative value {value}: signed integers are not supported")
    return str(number)


def flatten(value, abi_type, where):
    kind = abi_type["kind"]
    if kind in ("field", "integer", "boolean"):
        if isinstance(value, (list, dict)):
            raise SystemExit(f"{where}: expected a {kind}, got a container")
        yield scalar(value)
    elif kind == "array":
        if not isinstance(value, list) or len(value) != abi_type["length"]:
            raise SystemExit(f"{where}: expected an array of {abi_type['length']}")
        for i, item in enumerate(value):
            yield from flatten(item, abi_type["type"], f"{where}[{i}]")
    elif kind == "struct":
        for field in abi_type["fields"]:
            if field["name"] not in value:
                raise SystemExit(f"{where}.{field['name']}: missing from Prover.toml")
            yield from flatten(value[field["name"]], field["type"], f"{where}.{field['name']}")
    elif kind == "tuple":
        if not isinstance(value, list) or len(value) != len(abi_type["fields"]):
            raise SystemExit(f"{where}: expected a tuple of {len(abi_type['fields'])}")
        for i, (item, field_type) in enumerate(zip(value, abi_type["fields"])):
            yield from flatten(item, field_type, f"{where}.{i}")
    else:
        raise SystemExit(f"{where}: unsupported ABI type {kind}")


artifact = json.load(open(sys.argv[1]))
inputs = tomllib.load(open(sys.argv[2], "rb"))
values = []
for parameter in artifact["abi"]["parameters"]:
    name = parameter["name"]
    if name not in inputs:
        raise SystemExit(f"{name}: missing from Prover.toml")
    values.extend(flatten(inputs[name], parameter["type"], name))
print(json.dumps(values))
