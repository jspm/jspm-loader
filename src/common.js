import { errMsg } from "./err-msg.js";

export const hasSelf = typeof self !== "undefined";

export const hasDocument = typeof document !== "undefined";

const envGlobal = hasSelf ? self : global;
export { envGlobal as global };

export let baseUrl;

export function setBaseUrl(url) {
  // Verify it's a valid URL
  const URL = require("url").URL;
  baseUrl = new URL(url).href;
}

if (hasDocument) {
  const baseEl = document.querySelector("base[href]");
  if (baseEl) baseUrl = baseEl.href;
}

if (!baseUrl && typeof location !== "undefined") {
  baseUrl = location.href.split("#")[0].split("?")[0];
  const lastSepIndex = baseUrl.lastIndexOf("/");
  if (lastSepIndex !== -1) baseUrl = baseUrl.slice(0, lastSepIndex + 1);
}

const backslashRegEx = /\\/g;
export function resolveIfNotPlainOrUrl(relUrl, parentUrl) {
  if (relUrl.indexOf("\\") !== -1) relUrl = relUrl.replace(backslashRegEx, "/");
  // protocol-relative
  if (relUrl[0] === "/" && relUrl[1] === "/") {
    return parentUrl.slice(0, parentUrl.indexOf(":") + 1) + relUrl;
  }
  // relative-url
  else if (
    (relUrl[0] === "." &&
      (relUrl[1] === "/" ||
        (relUrl[1] === "." &&
          (relUrl[2] === "/" || (relUrl.length === 2 && (relUrl += "/")))) ||
        (relUrl.length === 1 && (relUrl += "/")))) ||
    relUrl[0] === "/"
  ) {
    const parentProtocol = parentUrl.slice(0, parentUrl.indexOf(":") + 1);
    // Disabled, but these cases will give inconsistent results for deep backtracking
    //if (parentUrl[parentProtocol.length] !== '/')
    //  throw Error('Cannot resolve');
    // read pathname from parent URL
    // pathname taken to be part after leading "/"
    let pathname;
    if (parentUrl[parentProtocol.length + 1] === "/") {
      // resolving to a :// so we need to read out the auth and host
      if (parentProtocol !== "file:") {
        pathname = parentUrl.slice(parentProtocol.length + 2);
        pathname = pathname.slice(pathname.indexOf("/") + 1);
      } else {
        pathname = parentUrl.slice(8);
      }
    } else {
      // resolving to :/ so pathname is the /... part
      pathname = parentUrl.slice(
        parentProtocol.length + (parentUrl[parentProtocol.length] === "/")
      );
    }

    if (relUrl[0] === "/")
      return (
        parentUrl.slice(0, parentUrl.length - pathname.length - 1) + relUrl
      );

    // join together and split for removal of .. and . segments
    // looping the string instead of anything fancy for perf reasons
    // '../../../../../z' resolved to 'x/y' is just 'z'
    const segmented = pathname.slice(0, pathname.lastIndexOf("/") + 1) + relUrl;

    const output = [];
    let segmentIndex = -1;
    for (let i = 0; i < segmented.length; i++) {
      // busy reading a segment - only terminate on '/'
      if (segmentIndex !== -1) {
        if (segmented[i] === "/") {
          output.push(segmented.slice(segmentIndex, i + 1));
          segmentIndex = -1;
        }
      }

      // new segment - check if it is relative
      else if (segmented[i] === ".") {
        // ../ segment
        if (
          segmented[i + 1] === "." &&
          (segmented[i + 2] === "/" || i + 2 === segmented.length)
        ) {
          output.pop();
          i += 2;
        }
        // ./ segment
        else if (segmented[i + 1] === "/" || i + 1 === segmented.length) {
          i += 1;
        } else {
          // the start of a new segment as below
          segmentIndex = i;
        }
      }
      // it is the start of a new segment
      else {
        segmentIndex = i;
      }
    }
    // finish reading out the last segment
    if (segmentIndex !== -1) output.push(segmented.slice(segmentIndex));
    return (
      parentUrl.slice(0, parentUrl.length - pathname.length) + output.join("")
    );
  }
}

/*
 * Import maps implementation
 *
 * To make lookups fast we pre-resolve the entire import map
 * and then match based on backtracked hash lookups
 *
 */

export function resolveUrl(relUrl, parentUrl) {
  return (
    resolveIfNotPlainOrUrl(relUrl, parentUrl) ||
    (relUrl.indexOf(":") !== -1
      ? relUrl
      : resolveIfNotPlainOrUrl("./" + relUrl, parentUrl))
  );
}

function objectAssign(to, from) {
  for (let p in from) to[p] = from[p];
  return to;
}

function resolveAndComposePackages(
  packages,
  outPackages,
  baseUrl,
  parentMap,
  parentUrl
) {
  for (let p in packages) {
    const resolvedLhs = resolveIfNotPlainOrUrl(p, baseUrl) || p;
    const rhs = packages[p];
    // package fallbacks not currently supported
    if (typeof rhs !== "string") continue;
    const mapped = resolveImportMap(
      parentMap,
      resolveIfNotPlainOrUrl(rhs, baseUrl) || rhs,
      parentUrl
    );
    if (!mapped) {
      if (DEV) targetWarning(2, p, rhs, "bare specifier did not resolve");
      else targetWarning(2, p, rhs);
    } else outPackages[resolvedLhs] = mapped;
  }
}

export function resolveAndComposeImportMap(json, baseUrl, parentMap) {
  const outMap = {
    imports: objectAssign({}, parentMap.imports),
    scopes: objectAssign({}, parentMap.scopes),
  };

  if (json.imports)
    resolveAndComposePackages(
      json.imports,
      outMap.imports,
      baseUrl,
      parentMap,
      null
    );

  if (json.scopes)
    for (let s in json.scopes) {
      const resolvedScope = resolveUrl(s, baseUrl);
      resolveAndComposePackages(
        json.scopes[s],
        outMap.scopes[resolvedScope] || (outMap.scopes[resolvedScope] = {}),
        baseUrl,
        parentMap,
        resolvedScope
      );
    }

  return outMap;
}

function getMatch(path, matchObj) {
  if (matchObj[path]) return path;
  let sepIndex = path.length;
  do {
    const segment = path.slice(0, sepIndex + 1);
    if (segment in matchObj) return segment;
  } while ((sepIndex = path.lastIndexOf("/", sepIndex - 1)) !== -1);
}

function applyPackages(id, packages) {
  const pkgName = getMatch(id, packages);
  if (pkgName) {
    const pkg = packages[pkgName];
    if (pkg === null) return;
    if (id.length > pkgName.length && pkg[pkg.length - 1] !== "/") {
      if (DEV) targetWarning(6, pkgName, pkg, "should have a trailing '/'");
      else targetWarning(6, pkgName, pkg);
    } else return pkg + id.slice(pkgName.length);
  }
}

function targetWarning(code, match, target, msg) {
  console.warn(
    errMsg(
      code,
      DEV
        ? "Package target " +
            msg +
            ", resolving target '" +
            target +
            "' for " +
            match
        : [target, match].join(", ")
    )
  );
}

export function resolveImportMap(importMap, resolvedOrPlain, parentUrl) {
  const scopes = importMap.scopes;
  let scopeUrl = parentUrl && getMatch(parentUrl, scopes);
  while (scopeUrl) {
    const packageResolution = applyPackages(resolvedOrPlain, scopes[scopeUrl]);
    if (packageResolution) return packageResolution;
    scopeUrl = getMatch(scopeUrl.slice(0, scopeUrl.lastIndexOf("/")), scopes);
  }
  return (
    applyPackages(resolvedOrPlain, importMap.imports) ||
    (resolvedOrPlain.indexOf(":") !== -1 && resolvedOrPlain)
  );
}
