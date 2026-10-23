// rules_js patches fs.promises through a replacement getter. Node's separate
// fs/promises module keeps the original methods. Next imports that module and
// would follow sandbox links outside its tracing root, dropping runtime files.
// Load after rules_js's --require hook, including in Next's child processes.
Object.assign(require("node:fs/promises"), require("node:fs").promises);
