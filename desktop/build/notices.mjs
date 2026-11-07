/**
 * Third-party notices for Delphi.app, harvested from what the build ships.
 *
 *   node build/notices.mjs        # writes .delphi-build/notices/, then checks it
 *
 * `npm run build` runs it last, because it reads every other step's output: the
 * bundled interpreter (.delphi-build/python), the shell's and the interface's
 * production npm trees, the interface's build (.delphi-build/dist) and Electron's
 * own distribution. electron-builder copies the result into Contents/Resources:
 * THIRD_PARTY_NOTICES.txt, licenses/, Delphi's LICENSE and NOTICE, and Electron's
 * LICENSES.chromium.html.
 *
 * Texts are read from the shipped files, never typed in. What no shipped file
 * carries (a statically linked library, a Rust crate, a font without an OFL file)
 * comes from build/licenses/, fetched once from the upstream sources.json names.
 * Anything the generator cannot account for stops the build rather than being
 * left out: a package with no licence or no licence text, a native library no
 * entry claims, a crate or statically linked module with no text, a font no
 * family owns, a package said not to ship whose code is in the interface build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = fileURLToPath(new URL("..", import.meta.url));

export function locations(desktop = DESKTOP) {
  return {
    desktop,
    repo: resolve(desktop, ".."),
    python: join(desktop, ".delphi-build/python"),
    ui: join(desktop, "frontend"),
    uiBuild: join(desktop, ".delphi-build/dist"),
    electron: join(desktop, "node_modules/electron/dist"),
    vendor: join(desktop, "build/licenses"),
    out: join(desktop, ".delphi-build/notices"),
  };
}

export class NoticesError extends Error {
  constructor(problems) {
    super(`Third-party notices are incomplete:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

// What a file is called when it holds a licence, a copyright or a patent grant.
const LICENCE_NAME = /^(licen[cs]e|copying|copyright|notice|authors|unlicense|patents)|licenseref/i;

/** A licence text: where it lands under licenses/, and its body. */
function text(path, from) {
  return { path, from, body: readFileSync(from, "utf8").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "") };
}

function walk(dir, keep = () => true) {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) found.push(...walk(path, keep));
    else if (keep(path)) found.push(path);
  }
  return found;
}

const posix = (path) => path.split(sep).join("/");

// ---------------------------------------------------------------- Python

/** Run inside the bundled interpreter: what it holds, as importlib reads it. */
const HARVEST = String.raw`
import json, sys, sysconfig
from importlib import metadata
from pathlib import Path
dists = []
for d in metadata.distributions():
    md = d.metadata
    files = [Path(d.locate_file(f)).resolve() for f in d.files or []]
    info = next(f.parent for f in files if f.name == "METADATA" and f.parent.name.endswith(".dist-info"))
    dists.append({
        "name": md["Name"], "version": md["Version"],
        "expression": md.get("License-Expression"), "license": md.get("License"),
        "classifiers": [c for c in md.get_all("Classifier") or [] if c.startswith("License ::")],
        "licenseFiles": md.get_all("License-File") or [],
        "distInfo": str(info), "files": [str(f) for f in files],
    })
dynload = Path(sysconfig.get_path("platstdlib")) / "lib-dynload"
print(json.dumps({
    "version": sys.version.split()[0],
    "modules": sorted(set(sys.builtin_module_names) | {p.name.split(".")[0] for p in dynload.glob("*.so")}),
    "stdlib": sysconfig.get_path("stdlib"),
    "site": sysconfig.get_path("purelib"),
    "dists": dists,
}))
`;

export function harvestPython(python) {
  const result = spawnSync(join(python, "bin/python3"), ["-I", "-c", HARVEST], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(`The bundled interpreter could not be read: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}

/** The distributions Delphi is, core and the desktop's layer over it: their licence is LICENSE and NOTICE, not a third party's. */
const FIRST_PARTY = new Set(["delphi-core", "delphi-desktop"]);

const canonical = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

const CLASSIFIERS = {
  "MIT License": "MIT",
  "BSD License": "BSD",
  "Apache Software License": "Apache-2.0",
  "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
  "Python Software Foundation License": "PSF-2.0",
  "ISC License (ISCL)": "ISC",
};
const PHRASES = { "MIT License": "MIT", "MIT license": "MIT", "The MIT License": "MIT", "BSD License": "BSD" };

/** The licence a distribution declares: an SPDX expression, a short field, or its classifiers. */
function pythonLicence(dist) {
  if (dist.expression) return dist.expression;
  const field = (dist.license ?? "").trim();
  if (field && !field.includes("\n") && field.length <= 80) return PHRASES[field] ?? field;
  const named = [...new Set(dist.classifiers.map((c) => CLASSIFIERS[c.split("::").pop().trim()]).filter(Boolean))];
  return named.length ? named.join(" OR ") : null;
}

/** Where a dual-licensed component is taken under one licence, which, and why it matters. */
const ELECTIONS = {
  "python:packaging": "BSD-2-Clause",
  "python:pypdfium2": "Apache-2.0, with PDFium's third-party components under LicenseRef-PdfiumThirdParty",
  "npm:dompurify": "Apache-2.0",
};

/**
 * What a wheel carries beyond its own code, and how it is accounted for.
 * `claims` are the native libraries (paths under site-packages) the entry
 * answers for; every .dylib in the interpreter must be claimed by one.
 * `components` name build/licenses/sources.json entries; `libraries` are
 * separate libraries listed one by one, each only when its file ships.
 */
const WHEEL_CONTENTS = {
  httptools: { notes: ["llhttp and http-parser are compiled into its parser; their licences are among its texts below."] },
  lxml: {
    notes: ["Its extension modules statically link libxml2, libxslt, libexslt and zlib (licences in LICENSES.txt below) and GNU libiconv."],
    libraries: [{
      name: "GNU libiconv", licence: "LGPL-2.1-or-later", common: ["LGPL-2.1"], source: "https://ftp.gnu.org/gnu/libiconv/",
      note: "Statically linked into lxml's etree module. lxml is a separate wheel in Contents/Resources/python, which you may replace with your own build.",
    }],
  },
  pillow: {
    claims: ["PIL/.dylibs/"],
    components: ["aom-patents", "libyuv-patents"],
    notes: ["The libraries in PIL/.dylibs are each named, with their licences, in Pillow's LICENSE below; FreeType is used under the FreeType License."],
  },
  pypdfium2: {
    claims: ["pypdfium2_raw/libpdfium.dylib"],
    notes: ["pypdfium2_raw/libpdfium.dylib is PDFium; the third-party code it contains is listed in LicenseRef-PdfiumThirdParty.txt below."],
  },
  pikepdf: {
    notes: ["The libraries in pikepdf/.dylibs are separate files, loaded at run time, and may be replaced. The (L)GPL ones are used under the LGPL; their source is available from the address given with each."],
    libraries: [
      { file: "pikepdf/.dylibs/libqpdf.", name: "qpdf", licence: "Apache-2.0", common: ["Apache-2.0"], components: ["qpdf"], source: "https://github.com/qpdf/qpdf" },
      { file: "pikepdf/.dylibs/libgnutls.", name: "GnuTLS", licence: "LGPL-2.1-or-later", common: ["LGPL-2.1"], source: "https://www.gnutls.org/download.html" },
      { file: "pikepdf/.dylibs/libnettle.", name: "Nettle (libnettle)", licence: "LGPL-3.0-or-later OR GPL-2.0-or-later", election: "LGPL-3.0-or-later", common: ["LGPL-3.0", "GPL-3.0"], source: "https://ftp.gnu.org/gnu/nettle/" },
      { file: "pikepdf/.dylibs/libhogweed.", name: "Nettle (libhogweed)", licence: "LGPL-3.0-or-later OR GPL-2.0-or-later", election: "LGPL-3.0-or-later", common: ["LGPL-3.0", "GPL-3.0"], source: "https://ftp.gnu.org/gnu/nettle/" },
      { file: "pikepdf/.dylibs/libgmp.", name: "GNU MP", licence: "LGPL-3.0-or-later OR GPL-2.0-or-later", election: "LGPL-3.0-or-later", common: ["LGPL-3.0", "GPL-3.0"], source: "https://gmplib.org/" },
      {
        file: "pikepdf/.dylibs/libidn2.", name: "Libidn2", licence: "LGPL-3.0-or-later OR GPL-2.0-or-later", election: "LGPL-3.0-or-later", common: ["LGPL-3.0", "GPL-3.0"], source: "https://ftp.gnu.org/gnu/libidn/",
        note: "This build also contains gnulib's version-etc module, which is GPL-3.0-or-later.",
      },
      { file: "pikepdf/.dylibs/libunistring.", name: "GNU libunistring", licence: "LGPL-3.0-or-later OR GPL-2.0-or-later", election: "LGPL-3.0-or-later", common: ["LGPL-3.0", "GPL-3.0"], source: "https://ftp.gnu.org/gnu/libunistring/" },
      { file: "pikepdf/.dylibs/libtasn1.", name: "GNU Libtasn1", licence: "LGPL-2.1-or-later", common: ["LGPL-2.1"], source: "https://ftp.gnu.org/gnu/libtasn1/" },
      { file: "pikepdf/.dylibs/libintl.", name: "GNU gettext runtime (libintl)", licence: "LGPL-2.1-or-later", common: ["LGPL-2.1"], source: "https://ftp.gnu.org/gnu/gettext/" },
      { file: "pikepdf/.dylibs/libp11-kit.", name: "p11-kit", licence: "BSD-3-Clause", components: ["p11-kit"], source: "https://github.com/p11-glue/p11-kit" },
      { file: "pikepdf/.dylibs/libjpeg.", name: "libjpeg-turbo", licence: "IJG AND BSD-3-Clause AND Zlib", components: ["libjpeg-turbo"], source: "https://github.com/libjpeg-turbo/libjpeg-turbo" },
    ],
  },
  pyyaml: { components: ["libyaml"] },
  uvloop: { components: ["libuv"] },
};

// Cargo records the registry path of every crate it compiles into panic locations.
const CRATE = /(?:index\.crates\.io|github\.com)-[0-9a-f]{16}\/([A-Za-z0-9_-]+?)-(\d+\.\d+\.\d+[A-Za-z0-9.+-]*)\//g;

export function cratesIn(binary) {
  const found = new Map();
  for (const [, name, version] of readFileSync(binary).toString("latin1").matchAll(CRATE)) found.set(`${name} ${version}`, { name, version });
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function vendored(vendor, sources, id, problems) {
  const component = sources.components[id];
  if (!component) { problems.push(`build/licenses/sources.json has no component "${id}"`); return []; }
  return component.files.map((file) => text(file, join(vendor, file)));
}

function commonTexts(vendor, sources, repo, names) {
  return names.map((name) => name === "Apache-2.0"
    ? text("common/Apache-2.0.txt", join(repo, "LICENSE"))
    : text(sources.common[name].file, join(vendor, sources.common[name].file)));
}

/**
 * The interpreter and every distribution it holds, as notice entries. Pure apart
 * from reading files, so a test can hand it a harvest that should fail.
 */
export function pythonEntries(harvest, { python, vendor, repo, sources }, problems) {
  const pbs = sources["python-build-standalone"];
  const runtime = [];
  const cpython = join(harvest.stdlib, "LICENSE.txt");
  runtime.push({
    name: `CPython ${harvest.version}`, licence: "PSF-2.0",
    source: `https://www.python.org/downloads/release/python-${harvest.version.replaceAll(".", "")}/`,
    ships: "Contents/Resources/python, built by python-build-standalone " + pbs.release + ` (${pbs.source})`,
    notes: ["The interpreter's documentation lists the software it incorporates; that list is the second text below."],
    texts: [text(`python/cpython-${harvest.version}/LICENSE.txt`, cpython), text(sources.cpython.file, join(vendor, sources.cpython.file))],
  });
  if (harvest.version !== pbs.python) problems.push(`the bundled interpreter is ${harvest.version}, but build/licenses holds python-build-standalone's texts for ${pbs.python}`);
  const linked = new Map();
  for (const module of harvest.modules) {
    const lib = pbs.modules[module];
    if (!lib) continue;
    const entry = linked.get(lib.component) ?? { name: lib.component, licence: lib.licence, source: lib.source, modules: [], texts: [text(lib.file, join(vendor, lib.file))] };
    entry.modules.push(module);
    linked.set(lib.component, entry);
  }
  for (const entry of linked.values()) {
    runtime.push({ ...entry, ships: `statically linked into the interpreter (${entry.modules.join(", ")})` });
  }

  const site = realpathSync(harvest.site);
  const owner = new Map();
  const packages = [];
  for (const dist of [...harvest.dists].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }))) {
    if (FIRST_PARTY.has(canonical(dist.name))) continue;
    for (const file of dist.files) owner.set(file, dist);
    const key = canonical(dist.name);
    const label = `${dist.name} ${dist.version}`;
    const licence = pythonLicence(dist);
    if (!licence) problems.push(`Python package ${label} declares no licence`);
    const wanted = new Set(dist.licenseFiles.map((f) => basename(f)));
    const texts = walk(dist.distInfo, (path) => {
      const rel = posix(relative(dist.distInfo, path));
      return rel.startsWith("licenses/") || LICENCE_NAME.test(basename(path)) || wanted.has(basename(path));
    }).map((path) => text(`python/${dist.name}-${dist.version}/${posix(relative(dist.distInfo, path)).replace(/^licenses\//, "")}`, path));
    if (!texts.length) problems.push(`Python package ${label} ships no licence text`);
    const contents = WHEEL_CONTENTS[key] ?? {};
    const includes = [];
    for (const id of contents.components ?? []) {
      const c = sources.components[id];
      includes.push({ name: c?.name ?? id, version: c?.seen, licence: c?.licence, source: c?.source, texts: vendored(vendor, sources, id, problems) });
    }
    for (const lib of contents.libraries ?? []) {
      if (lib.file && !dist.files.some((f) => posix(relative(site, f)).startsWith(lib.file))) continue;
      includes.push({
        name: lib.name, licence: lib.licence, election: lib.election, source: lib.source, note: lib.note,
        texts: [...(lib.components ?? []).flatMap((id) => vendored(vendor, sources, id, problems)), ...commonTexts(vendor, sources, repo, lib.common ?? [])],
      });
    }
    const common = /MPL-2\.0/.test(licence ?? "") ? commonTexts(vendor, sources, repo, ["MPL-2.0"]) : [];
    packages.push({
      key, name: dist.name, version: dist.version, licence, election: ELECTIONS[`python:${key}`],
      source: `https://pypi.org/project/${dist.name}/${dist.version}/`,
      notes: contents.notes, includes, texts: [...texts, ...common], dist,
    });
  }

  // Every native library is claimed by an entry, and every crate compiled into
  // a binary has a text.
  const crates = sources.crates;
  for (const file of walk(realpathSync(python), (path) => /\.(dylib|so)$/.test(path))) {
    const rel = posix(relative(site, file));
    const dist = owner.get(file);
    if (file.endsWith(".dylib") && rel.startsWith("..")) {
      // Outside site-packages the only library is the interpreter's own.
      if (!/^lib\/libpython3\.\d+\.dylib$/.test(posix(relative(realpathSync(python), file)))) problems.push(`native library ${posix(relative(python, file))} is not accounted for`);
    } else if (file.endsWith(".dylib")) {
      const entry = dist && packages.find((p) => p.dist === dist);
      const contents = entry ? WHEEL_CONTENTS[entry.key] ?? {} : {};
      const claimed = (contents.claims ?? []).some((prefix) => rel.startsWith(prefix))
        || (contents.libraries ?? []).some((lib) => lib.file && rel.startsWith(lib.file));
      if (!claimed) problems.push(`native library ${rel} is not accounted for: add it to WHEEL_CONTENTS in build/notices.mjs`);
    }
    const found = cratesIn(file);
    if (!found.length) continue;
    const entry = dist && packages.find((p) => p.dist === dist);
    if (!entry) { problems.push(`${posix(relative(python, file))} contains Rust crates but belongs to no listed package`); continue; }
    for (const crate of found) {
      const known = crates[crate.name];
      if (!known) { problems.push(`Rust crate ${crate.name} ${crate.version} (in ${rel}) has no licence text in build/licenses`); continue; }
      if (entry.includes.some((i) => i.name === crate.name && i.version === crate.version)) continue;
      entry.includes.push({
        name: crate.name, version: crate.version, licence: known.declared, election: known.used !== known.declared ? known.used : undefined,
        source: `https://crates.io/crates/${crate.name}/${crate.version}`, crate: true,
        texts: known.files.map((f) => text(f, join(vendor, f))),
      });
    }
  }
  return { runtime, packages };
}

// ---------------------------------------------------------------- npm

/**
 * Packages in the interface's production closure that do not reach its build,
 * with why, and strings their code would bring into it if they did.
 */
const UI_NOT_SHIPPED = {
  "sharp": { why: "Next.js's server image optimiser, which vinext does not use", markers: ["@img/sharp", "sharp-libvips"] },
  "caniuse-lite": { why: "browser-support data, read by build tools", markers: ["caniuse"] },
  "baseline-browser-mapping": { why: "browser-support data, read by build tools", markers: ["baseline-browser-mapping"] },
  "styled-jsx": { why: "Next.js's CSS-in-JS runtime, which this interface does not use", markers: ["styled-jsx"] },
  "drizzle-orm": { why: "imported only by frontend/db, which the app never loads", markers: ["drizzle"] },
  "@next/env": { why: "Next.js's .env loader, run by its own command line", markers: ["@next/env"] },
  // pdf.js asks Node's own `require` for it at run time, from a node_modules the app does not carry.
  "@napi-rs/canvas": { why: "loaded only by pdf.js running in Node, from node_modules, which the app does not carry", markers: [] },
};

/** Build tools whose run-time helpers the interface's bundles contain, though they are devDependencies. */
const UI_BUILD_RUNTIMES = [["vinext"], ["react-server-dom-webpack"], ["@vitejs/plugin-rsc"], ["vite"], ["vite", "rolldown"]];

/** Declared in a licence file, not in package.json. */
const DECLARED_IN_FILE = { khroma: "MIT" };

/** Packages that ship no licence file: the vendored component that holds their text. */
const NPM_VENDORED = { "rehype-katex": "remark-math", "remark-math": "remark-math", "@vitejs/plugin-rsc": "vite-plugin-react" };

function resolvePackage(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    if (dirname(dir) === dir) return null;
  }
}

function npmLicence(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return DECLARED_IN_FILE[pkg.name] ?? null;
}

/**
 * A production npm closure as notice entries: dependencies, optional
 * dependencies that are installed and peers that are required, from `roots`.
 */
export function npmEntries(root, { roots, single = [], notShipped = {}, bundled = false, vendor, sources }, problems) {
  const seen = new Map();
  const skipped = new Map();
  const add = (dir, descend) => {
    if (seen.has(dir)) return;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (notShipped[pkg.name]) { skipped.set(pkg.name, pkg.version); return; }
    // A platform binary: a bundle of JavaScript and assets cannot contain it. The
    // shell's node_modules are copied as they are, so there it would ship.
    if (bundled && (pkg.os || pkg.cpu)) { skipped.set(pkg.name, pkg.version); return; }
    const label = `${pkg.name} ${pkg.version}`;
    const licence = npmLicence(pkg);
    if (!licence) problems.push(`npm package ${label} declares no licence`);
    let texts = readdirSync(dir).filter((f) => LICENCE_NAME.test(f) && statSync(join(dir, f)).isFile()).sort()
      .map((f) => text(`npm/${pkg.name}@${pkg.version}/${f}`, join(dir, f)));
    if (!texts.length && NPM_VENDORED[pkg.name]) texts = vendored(vendor, sources, NPM_VENDORED[pkg.name], problems);
    if (!texts.length) problems.push(`npm package ${label} ships no licence text: add one to build/licenses`);
    seen.set(dir, {
      key: pkg.name, name: pkg.name, version: pkg.version, licence, election: ELECTIONS[`npm:${pkg.name}`],
      source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, texts,
    });
    if (!descend) return;
    const optional = pkg.optionalDependencies ?? {};
    const peers = Object.keys(pkg.peerDependencies ?? {}).filter((n) => !pkg.peerDependenciesMeta?.[n]?.optional);
    for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(optional), ...peers]) {
      const found = resolvePackage(dir, name);
      if (found) add(found, true);
      else if (!(name in optional)) problems.push(`${label} depends on ${name}, which is not installed`);
    }
  };
  for (const name of roots) {
    const found = resolvePackage(root, name);
    if (found) add(found, true); else problems.push(`${name} is not installed under ${root}`);
  }
  for (const chain of single) {
    let dir = root;
    for (const name of chain) dir = dir && resolvePackage(dir, name);
    if (dir) add(dir, false); else problems.push(`${chain.join(" → ")} is not installed under ${root}`);
  }
  const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { entries, skipped };
}

/** Nothing in the interface build is native code, and nothing said not to ship is in it. */
export function checkUiBuild(uiBuild, skipped, problems) {
  const files = walk(uiBuild);
  for (const file of files) {
    if (/\.(node|dylib|so)$/.test(file)) problems.push(`the interface build contains native code: ${posix(relative(uiBuild, file))}`);
  }
  const textual = files.filter((f) => /\.(m?js|css|html|json|map)$/.test(f)).map((f) => readFileSync(f, "utf8"));
  for (const [name, { markers }] of Object.entries(UI_NOT_SHIPPED)) {
    if (!skipped.has(name)) continue;
    for (const marker of markers) {
      if (textual.some((body) => body.includes(marker))) problems.push(`${name} is listed as not shipped, but "${marker}" is in the interface build`);
    }
  }
}

// ---------------------------------------------------------------- the rest

/** Electron's frameworks that are Electron itself, and the ones listed apart. */
const ELECTRON_FRAMEWORKS = { "Mantle.framework": "mantle", "ReactiveObjC.framework": "reactiveobjc", "Squirrel.framework": "squirrel" };

function electronEntries(electron, { vendor, sources }, problems) {
  const version = readFileSync(join(electron, "version"), "utf8").trim().replace(/^v/, "");
  const entries = [{
    name: `Electron ${version}`, licence: "MIT", source: `https://github.com/electron/electron/tree/v${version}`,
    ships: "Delphi.app's executable, Contents/Frameworks/Electron Framework.framework and the helper apps",
    texts: [text("electron/LICENSE", join(electron, "LICENSE"))],
  }, {
    name: "Chromium, and the components Electron is built from (V8, Node.js, FFmpeg, ICU, Skia and others)",
    licence: "each component's own; see LICENSES.chromium.html", source: `https://github.com/electron/electron/blob/v${version}/DEPS`,
    ships: "inside Electron Framework.framework",
    notes: [
      "Their notices are LICENSES.chromium.html, Electron's own file, shipped unmodified beside this one.",
      "FFmpeg is the separate library Electron Framework.framework/Libraries/libffmpeg.dylib, used under LGPL-2.1-or-later; its source is part of Chromium's, at the version Electron's DEPS names.",
    ],
    texts: [],
  }];
  const frameworks = join(electron, "Electron.app/Contents/Frameworks");
  for (const name of readdirSync(frameworks).sort()) {
    if (name === "Electron Framework.framework" || /^Electron Helper.*\.app$/.test(name)) continue;
    const id = ELECTRON_FRAMEWORKS[name];
    if (!id) { problems.push(`Electron ships ${name}, which no entry accounts for`); continue; }
    const c = sources.components[id];
    entries.push({ name: c.name, licence: c.licence, source: c.source, ships: `Contents/Frameworks/${name}, part of Electron's distribution`, texts: vendored(vendor, sources, id, problems) });
  }
  return { version, entries };
}

/** Font families, the files that belong to each, and the text that licenses them. */
const FONTS = [
  { family: "Bricolage Grotesque", files: /^bricolage-grotesque/, text: "frontend/public/fonts/bricolage-grotesque-OFL.txt", source: "https://github.com/ateliertriay/bricolage" },
  { family: "Figtree", files: /^figtree/, text: "frontend/public/fonts/figtree-OFL.txt", source: "https://github.com/erikdkennedy/figtree" },
  { family: "Plus Jakarta Sans", files: /^plus-jakarta-sans/, text: "frontend/public/fonts/plus-jakarta-sans-OFL.txt", source: "https://github.com/tokotype/PlusJakartaSans" },
  { family: "JetBrains Mono", files: /^jetbrains-mono/, text: "frontend/public/fonts/jetbrains-mono-OFL.txt", source: "https://github.com/JetBrains/JetBrainsMono" },
  { family: "STIX Two Math", files: /^stix-two-math/, text: "frontend/public/fonts/stix-two-math-OFL.txt", source: "https://github.com/stipub/stixfonts" },
  { family: "KaTeX fonts (KaTeX_AMS, KaTeX_Main, KaTeX_Math and the rest)", files: /^KaTeX_/, text: "build/licenses/fonts/katex-OFL.txt", source: "https://github.com/KaTeX/katex-fonts" },
];

function fontEntries({ desktop, uiBuild }, resources, problems) {
  const where = new Map(FONTS.map((f) => [f, new Set()]));
  // The interface build holds every font, public/fonts included; extraResources
  // copies a few of those again for the first-run window.
  const copied = resources.find((r) => r.from === "frontend/public/fonts")?.filter ?? [];
  const fonts = [...walk(uiBuild), ...copied.map((name) => join(desktop, "frontend/public/fonts", name))].filter((f) => /\.(woff2?|ttf|otf)$/i.test(f));
  for (const file of fonts) {
    const family = FONTS.find((f) => f.files.test(basename(file)));
    if (!family) { problems.push(`font ${basename(file)} belongs to no family in build/notices.mjs`); continue; }
    where.get(family).add(file.startsWith(uiBuild) ? "Contents/Resources/dist" : "Contents/Resources/frontend/public/fonts");
  }
  return FONTS.filter((f) => where.get(f).size).map((f) => {
    const from = join(desktop, f.text);
    if (!existsSync(from)) { problems.push(`${f.family} has no licence text at ${f.text}`); return null; }
    return { name: f.family, licence: "OFL-1.1", source: f.source, ships: [...where.get(f)].join(" and "), texts: [text(`fonts/${basename(f.text)}`, from)] };
  }).filter(Boolean);
}

/** The persona adapted from another project; its notice lives in the module that carries it. */
function contentEntries(repo, problems) {
  const source = join(repo, "core/delphi_core/personas.py");
  const body = readFileSync(source, "utf8");
  const notice = body.match(/\n((?: {4}Copyright \(c\)[^\n]*\n)(?: {4}[^\n]*\n|\n)*? {4}SOFTWARE\.\n)/);
  const url = body.match(/https:\/\/github\.com\/[^\s)]+/);
  if (!notice || !url || !notice[1].includes("Permission is hereby granted")) {
    problems.push("core/delphi_core/personas.py no longer carries the ADHD persona's MIT notice where the generator reads it");
    return [];
  }
  const holder = notice[1].split("\n")[0].trim();
  return [{
    name: "ADHD persona (adapted from i-have-adhd)", licence: "MIT", source: url[0],
    ships: "the backend's personas module, Contents/Resources/python/lib/python3.12/site-packages/delphi_core/personas.py",
    notes: [`${holder}. Adapted and retargeted from a coding harness to reading documents.`],
    texts: [{ path: "content/i-have-adhd/LICENSE", body: notice[1].replace(/^ {4}/gm, "").trim() }],
  }];
}

function pbsPin(repo) {
  const script = readFileSync(join(repo, "scripts/python-standalone.sh"), "utf8");
  return { release: script.match(/^PBS_RELEASE="([^"]+)"/m)?.[1], python: script.match(/^PBS_PYTHON="([^"]+)"/m)?.[1] };
}

// ---------------------------------------------------------------- rendering

const RULE = "=".repeat(78);
const LINE = "-".repeat(78);

const ACKNOWLEDGEMENTS = [
  "Portions of this software are copyright (c) 2024 The FreeType Project (www.freetype.org). All rights reserved.",
  "This software is based in part on the work of the Independent JPEG Group.",
  "The AV1 codec in Pillow's libavif is distributed under the Alliance for Open Media Patent License 1.0, quoted under Pillow above.",
];

const TRADEMARKS = [
  "\"Delphi\" and the Delphi logo are not licensed; see TRADEMARKS.md in Delphi's source repository.",
  "\"ChatGPT\" and its logo are trademarks of OpenAI, and \"Claude\" and its logo are trademarks of Anthropic. Delphi shows them only to name the service a connection uses, is not affiliated with or endorsed by either company, and does not license them to you.",
];

/** Wraps prose at 78 columns; `hang` indents the lines after the first. */
function wrap(prose, indent = "", hang = "") {
  const lines = [];
  let line = indent;
  for (const word of prose.split(/\s+/)) {
    if (line.length + word.length + 1 > 78 && line.trim()) { lines.push(line.trimEnd()); line = indent + hang; }
    line += word + " ";
  }
  lines.push(line.trimEnd());
  return lines.join("\n");
}

function licenceLine(entry) {
  return entry.election ? `${entry.licence}, used under ${entry.election}` : entry.licence ?? "not declared";
}

/** Renders the notices and gathers every text that goes into licenses/. */
export function render(model) {
  const files = new Map();
  const quoted = new Map();
  const out = [];
  const quote = (t, owner) => {
    const prior = files.get(t.path);
    if (prior !== undefined && prior !== t.body) throw new Error(`two different texts would be written to licenses/${t.path}`);
    files.set(t.path, t.body);
    const digest = createHash("sha256").update(t.body).digest("hex");
    if (quoted.has(digest)) return `== licenses/${t.path} (the same text as under ${quoted.get(digest)}, above) ==\n`;
    quoted.set(digest, owner);
    return `== licenses/${t.path} ==\n${t.body}\n`;
  };
  const entry = (e) => {
    const title = e.version ? `${e.name} ${e.version}` : e.name;
    const head = [title, `Licence: ${licenceLine(e)}`];
    if (e.source) head.push(`Source: ${e.source}`);
    if (e.ships) head.push(wrap(`Ships as: ${e.ships}`, "", "  "));
    for (const note of e.notes ?? []) head.push(wrap(note));
    const parts = [head.join("\n")];
    if (e.includes?.length) {
      const lines = ["Includes:"];
      for (const i of e.includes) {
        lines.push(wrap(`- ${i.version ? `${i.name} ${i.version}` : i.name}${i.crate ? " (Rust crate)" : ""}: ${licenceLine(i)}${i.source ? `, ${i.source}` : ""}${i.note ? `. ${i.note}` : ""}`, "  ", "  "));
      }
      parts.push(lines.join("\n"));
    }
    const texts = [...e.texts, ...(e.includes ?? []).flatMap((i) => i.texts.map((t) => ({ ...t, owner: i.version ? `${i.name} ${i.version}` : i.name })))];
    for (const t of texts) parts.push(quote(t, t.owner ?? title).trimEnd());
    return parts.join("\n\n");
  };
  const section = (number, title, intro, entries) => {
    out.push(RULE, `${number}. ${title}`, RULE, "", wrap(intro), "");
    for (const e of entries) out.push(LINE, entry(e), "");
  };

  out.push(
    `THIRD-PARTY NOTICES FOR DELPHI ${model.version}`, "",
    wrap("Delphi is Copyright 2026 Kevin Li and licensed under the Apache License, Version 2.0: see LICENSE and NOTICE beside this file. Delphi.app also contains the third-party software, fonts and content listed below. Each is distributed under its own licence, quoted in full under its entry and kept as a separate file in licenses/, and none of it is licensed to you by Delphi."), "",
    wrap("This file is generated by desktop/build/notices.mjs in Delphi's source from the files in this build."), "",
    "Contents",
    ...[...model.sections.map((s) => s.title), "Acknowledgements", "Trademarks"].map((title, i) => `  ${i + 1}. ${title}`),
    "",
  );
  model.sections.forEach((s, i) => section(i + 1, s.title, s.intro, s.entries));
  for (const [i, [title, paragraphs]] of [["Acknowledgements", ACKNOWLEDGEMENTS], ["Trademarks", TRADEMARKS]].entries()) {
    out.push(RULE, `${model.sections.length + i + 1}. ${title}`, RULE, "", ...paragraphs.flatMap((a) => [wrap(a), ""]));
  }
  return { notices: out.join("\n").replace(/\n+$/, "\n"), files };
}

// ---------------------------------------------------------------- the whole

export function collect(where = locations()) {
  const problems = [];
  const sources = JSON.parse(readFileSync(join(where.vendor, "sources.json"), "utf8"));
  const pin = pbsPin(where.repo);
  const pbs = sources["python-build-standalone"];
  if (pin.release !== pbs.release || pin.python !== pbs.python) {
    problems.push(`scripts/python-standalone.sh pins python-build-standalone ${pin.python}+${pin.release}, but build/licenses holds the texts of ${pbs.python}+${pbs.release}: refresh them from that release's full archive`);
  }
  const context = { ...where, sources };
  const harvest = harvestPython(where.python);
  const python = pythonEntries(harvest, context, problems);
  const shellPackage = JSON.parse(readFileSync(join(where.desktop, "package.json"), "utf8"));
  const shell = npmEntries(where.desktop, { roots: Object.keys(shellPackage.dependencies ?? {}), ...context }, problems);
  const uiPackage = JSON.parse(readFileSync(join(where.ui, "package.json"), "utf8"));
  const ui = npmEntries(where.ui, { roots: Object.keys(uiPackage.dependencies ?? {}), single: UI_BUILD_RUNTIMES, notShipped: UI_NOT_SHIPPED, bundled: true, ...context }, problems);
  checkUiBuild(where.uiBuild, ui.skipped, problems);
  const electron = electronEntries(where.electron, context, problems);
  const notShipped = [...ui.skipped].map(([name, version]) => `${name} ${version} (${UI_NOT_SHIPPED[name]?.why ?? "a platform-specific binary"})`);
  const model = {
    version: shellPackage.version,
    sections: [
      { title: "Electron and Chromium", intro: `Delphi.app is an Electron ${electron.version} application.`, entries: electron.entries },
      { title: "The Python interpreter", intro: "The backend runs on a CPython interpreter built by python-build-standalone, which links the libraries below into it statically. The other libraries the interpreter uses are macOS's own.", entries: python.runtime },
      { title: "Python packages", intro: "Installed in Contents/Resources/python/lib/python3.12/site-packages. Each package's source, for the exact version shipped, is on PyPI at the address given.", entries: python.packages },
      { title: "JavaScript packages in the app shell", intro: "The production dependencies of Delphi's Electron main process, in Contents/Resources/app.asar.", entries: shell.entries },
      { title: "JavaScript packages in the interface", intro: `Bundled into Contents/Resources/dist by the interface's build: its production dependencies, and the run-time helpers of the build tools that produced it. Listed in full; the build may contain less. Not listed, because the build contains none of their code: ${notShipped.join("; ")}.`, entries: ui.entries },
      { title: "Fonts", intro: "Each family is licensed under the SIL Open Font License 1.1. The fonts may be bundled and embedded, but not sold on their own, and a modified version may not use a Reserved Font Name.", entries: fontEntries(where, shellPackage.build?.extraResources ?? [], problems) },
      { title: "Adapted content", intro: "Third-party text Delphi's own code adapts.", entries: contentEntries(where.repo, problems) },
    ],
  };
  return { model, problems, site: realpathSync(harvest.site), python, shell, ui };
}

export function write(model, out, where = locations()) {
  const { notices, files } = render(model);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "THIRD_PARTY_NOTICES.txt"), notices);
  for (const [path, body] of files) {
    mkdirSync(dirname(join(out, "licenses", path)), { recursive: true });
    writeFileSync(join(out, "licenses", path), body + "\n");
  }
  for (const name of ["LICENSE", "NOTICE"]) copyFileSync(join(where.repo, name), join(out, name));
  copyFileSync(join(where.electron, "LICENSES.chromium.html"), join(out, "LICENSES.chromium.html"));
  return notices;
}

/** The distributions a site-packages directory holds, read from the files and not through importlib. */
export function installedDistributions(site) {
  return readdirSync(site).filter((d) => d.endsWith(".dist-info")).map((d) => {
    const fields = Object.fromEntries(readFileSync(join(site, d, "METADATA"), "utf8").split("\n\n")[0].split("\n")
      .map((line) => line.match(/^(Name|Version): (.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
    return { name: fields.Name, version: fields.Version };
  }).filter((d) => !FIRST_PARTY.has(canonical(d.name)));
}

/**
 * Independent of the generator: every distribution in the shipped interpreter
 * has an entry, and every licence text the notices quote is in licenses/.
 */
export function verify(out, site) {
  const problems = [];
  const notices = readFileSync(join(out, "THIRD_PARTY_NOTICES.txt"), "utf8");
  const headings = new Set(notices.split("\n" + LINE + "\n").slice(1).map((block) => block.split("\n")[0]));
  for (const { name, version } of installedDistributions(site)) {
    if (!headings.has(`${name} ${version}`)) problems.push(`the bundled interpreter holds ${name} ${version}, which THIRD_PARTY_NOTICES.txt does not list`);
  }
  const quoted = new Set([...notices.matchAll(/^== licenses\/(.+?)(?: \(the same text as under .*\))? ==$/gm)].map((m) => m[1]));
  for (const path of quoted) {
    if (!existsSync(join(out, "licenses", path))) problems.push(`THIRD_PARTY_NOTICES.txt quotes licenses/${path}, which is missing`);
  }
  for (const name of ["LICENSE", "NOTICE", "LICENSES.chromium.html"]) {
    if (!existsSync(join(out, name))) problems.push(`${name} is missing from ${out}`);
  }
  return problems;
}

export function main(where = locations()) {
  if (!existsSync(join(where.electron, "version"))) {
    // Electron downloads its distribution on first use; its installer verifies the
    // archive against the checksums the npm package pins.
    const installed = spawnSync(process.execPath, [join(where.desktop, "node_modules/electron/install.js")], { stdio: "inherit" });
    if (installed.status !== 0) throw new Error("Electron's distribution could not be installed");
  }
  const { model, problems, site } = collect(where);
  if (problems.length) throw new NoticesError(problems);
  write(model, where.out, where);
  const failed = verify(where.out, site);
  if (failed.length) throw new NoticesError(failed);
  const count = model.sections.reduce((n, s) => n + s.entries.length, 0);
  console.log(`third-party notices -> ${where.out} (${count} entries)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
