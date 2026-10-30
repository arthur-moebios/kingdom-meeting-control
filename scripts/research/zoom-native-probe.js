// Inventory is read-only. The explicit status command calls only the tiny,
// disassembled, version-checked internal getter; no hooks or UI actions.
rpc.exports = {
  status() {
    const module = Process.getModuleByName("zVideoUI.dll");
    const entry = module.getExportByName("?IsInMeeting@UICommandBridge@@SAHXZ");
    const expected = ["mov", "xor", "test", "je", "cmp", "sete", "ret"];
    let address = entry;
    for (const mnemonic of expected) {
      const instruction = Instruction.parse(address);
      if (instruction.mnemonic !== mnemonic) throw new Error("Unexpected getter code; invocation refused");
      address = instruction.next;
    }
    const getter = new NativeFunction(entry, "int", [], "win64");
    const value = getter();
    return { kind: "internal-getter-call", processId: Process.id,
      function: "UICommandBridge::IsInMeeting()", value, inMeeting: value === 1,
      semanticsValidated: false,
      limitations: ["The getter executed, but its result has not been corroborated against meeting state in the correct process/context.",
        "Start/stop/optimization are not implemented."] };
  },
  inventory() {
    const module = Process.getModuleByName("zVideoUI.dll");
    return {
      kind: "live-module-inventory",
      processId: Process.id,
      architecture: Process.arch,
      module: { name: module.name, path: module.path, base: module.base.toString(), size: module.size },
      exports: module.enumerateExports()
        .filter(entry => /ShareApiBridge|GetShareApi|IsInMeeting|GetShareStatus|OptimizeVideoClip/.test(entry.name))
        .map(entry => ({ name: entry.name, type: entry.type,
          address: entry.address.toString(), rva: entry.address.sub(module.base).toString() })),
      instructions: module.enumerateExports()
        .filter(entry => /\?(IsInMeeting@UICommandBridge|GetShareStatus@ConfStatusBridge|StopShare@ShareApiBridge|GetShareApi@CmmApiGetter)/.test(entry.name))
        .map(entry => {
          const rows = [];
          let address = entry.address;
          for (let i = 0; i < 45; i++) {
            const instruction = Instruction.parse(address);
            rows.push({ address: address.toString(), rva: address.sub(module.base).toString(),
              mnemonic: instruction.mnemonic, operands: instruction.opStr });
            address = instruction.next;
            if (instruction.mnemonic === "ret") break;
          }
          return { name: entry.name, rows };
        }),
      limitations: ["Module/export presence does not validate ABI, calling thread, or command behavior."],
    };
  },
};
