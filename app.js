// Roman's wish list. Everything lives in Firestore (see firestore.rules):
//   items/<id>   { title, details, shared, cta?, order }   the wishes
//   claims/<id>  { item, name, at }                        who plans to give what
//   people/<id>  { name, at }                              names for the dropdown
// Nobody needs an account. Picking the name "Roman" hides the picks and opens editing.
(function () {
  var OWNER = "Roman";
  // Signing in as Roman takes a passcode. Only its hash is kept here. This keeps
  // family from wandering in by accident; it is not strong security.
  var CODE_SALT = "roman-wish-list:";
  var OWNER_HASH = "3efd2f336b98ec0145dac2692cd1ddda60119447998a793707a148d8dab6dc56";

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  var S = {
    name: (store.get("wl-name") || "").trim(),
    db: null,
    itemsStatus: "loading",  // loading | slow | ready | error  (the list itself)
    status: "idle",          // idle | loading | slow | ready | error  (the picks)
    pick: "", draft: "",     // the name card's dropdown value and typed name
    code: "", codeWrong: false, checking: false,  // the passcode field shown for Roman
    edit: null,              // { id | null, title, details, shared } while the editor is open
    confirm: null,           // id of the item waiting on "Remove?"
    saving: false, editFlash: "",
    busy: null, flash: {}
  };
  var items = [], claims = [], people = [], stopClaims = null, timer = null;

  // A browser that remembers the name Roman but never entered the passcode starts over.
  if (S.name && S.name.toLowerCase() === OWNER.toLowerCase() && store.get("wl-owner") !== OWNER_HASH) {
    S.name = ""; store.set("wl-name", "");
  }

  function h(tag, attrs) {
    var n = document.createElement(tag), k;
    for (k in (attrs || {})) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) n.append(x); });
      else n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  function same(a, b) { return a.trim().toLowerCase() === b.trim().toLowerCase(); }
  function isOwner() { return !!S.name && same(S.name, OWNER); }
  function isMine(c) { return !!S.name && same(c.name, S.name); }
  function canAct() { return !!S.db && S.status === "ready" && !isOwner(); }
  function canEdit() { return !!S.db && S.itemsStatus === "ready" && isOwner(); }
  function knownNames() {
    var out = [OWNER];
    people.forEach(function (n) { if (!out.some(function (o) { return same(o, n); })) out.push(n); });
    return out;
  }
  function slug(text) {
    var s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s || "x" + Math.random().toString(36).slice(2, 10);
  }
  function sharedStatus(mine, others) {
    if (mine) return others === 0 ? "You're giving this" : "You and " + others + (others === 1 ? " other are" : " others are") + " giving this";
    return others === 1 ? "1 person is giving this" : others + " people are giving this";
  }
  function cleanItems(list) {
    return list.map(function (x, i) {
      return { id: x.id, title: x.title, details: typeof x.details === "string" ? x.details : "",
        shared: !!x.shared, cta: typeof x.cta === "string" ? x.cta.slice(0, 30) : "",
        order: typeof x.order === "number" ? x.order : 1000 + i };
    }).filter(function (it) { return typeof it.title === "string" && it.title.trim(); })
      .sort(function (a, b) { return a.order - b.order || (a.id < b.id ? -1 : 1); });
  }

  /* ---------- the small text format Roman types in ---------- */

  // [words](https://link) makes the words a link, a bare https://link is clickable
  // as itself, and *asterisks* become italics
  var MD_LINK = /\[([^\]]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/;
  var BARE_URL = /https?:\/\/[^\s<>\[\]]+/;
  var ITALIC = /\*([^*]+)\*/;
  var WITH_LINKS = new RegExp(MD_LINK.source + "|(" + BARE_URL.source + ")|" + ITALIC.source, "g");
  var NO_LINKS = new RegExp(ITALIC.source, "g");

  function anchor(url) { return h("a", { href: url, target: "_blank", rel: "noopener" }); }

  function inline(parent, text, insideLink) {
    text = String(text);
    var re = insideLink ? NO_LINKS : WITH_LINKS;
    re.lastIndex = 0;
    var last = 0, m;
    while ((m = re.exec(text))) {
      var end = m.index + m[0].length, node;
      if (insideLink) {
        node = h("em", { text: m[1] });
      } else if (m[2]) {
        node = anchor(m[2]); inline(node, m[1], true);
      } else if (m[3]) {
        // punctuation right after a pasted link belongs to the sentence, not the link
        var url = m[3].replace(/[.,;:!?'"]+$/, "");
        if (/\)$/.test(url) && url.indexOf("(") < 0) url = url.replace(/\)+$/, "");
        end = m.index + url.length;
        node = anchor(url); node.textContent = url;
      } else {
        node = h("em"); inline(node, m[4], false);
      }
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      parent.append(node);
      last = end; re.lastIndex = end;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }
  // lines starting "1." make a numbered list, lines starting "-" make bullets
  function detailNodes(text) {
    var out = [], list = null, kind = null;
    String(text || "").split("\n").forEach(function (raw) {
      var line = raw.trim();
      if (!line) { list = null; return; }
      var o = line.match(/^\d+[.)]\s+(.*)$/), u = line.match(/^[-*]\s+(.*)$/);
      var k = o ? "ol" : u ? "ul" : null;
      if (k) {
        if (!list || kind !== k) { list = h(k); kind = k; out.push(list); }
        var li = h("li"); inline(li, (o || u)[1]); list.append(li);
      } else {
        list = null;
        var p = h("p"); inline(p, line); out.push(p);
      }
    });
    return out;
  }

  /* ---------- signing in with a name ---------- */

  function startClaims() {
    if (!S.db || !S.name || isOwner() || stopClaims) return;
    S.status = "loading";
    timer = setTimeout(function () { if (S.status === "loading") { S.status = "slow"; render(); } }, 10000);
    stopClaims = S.db.collection("claims").onSnapshot(function (snap) {
      claims = snap.docs.map(function (d) {
        var x = d.data() || {};
        return { id: d.id, item: x.item, name: x.name, at: x.at || "" };
      }).filter(function (c) { return typeof c.item === "string" && typeof c.name === "string" && c.name.trim(); })
        .sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
      if (!snap.metadata.fromCache) { clearTimeout(timer); S.status = "ready"; }
      render();
    }, function () { clearTimeout(timer); S.status = "error"; render(); });
  }

  function signIn(name, isNew) {
    S.name = name; store.set("wl-name", name);
    S.pick = ""; S.draft = "";
    if (isNew && S.db) {
      S.db.collection("people").doc(slug(name)).set({ name: name, at: new Date().toISOString() })
        .catch(function () {});
    }
    startClaims();
    render();
  }

  async function sha(text) {
    var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function focusCode() { var i = document.getElementById("owner-code"); if (i) i.focus(); }

  // Choosing Roman: first show the passcode field, then check what was typed.
  async function ownerSubmit() {
    if (S.pick !== OWNER) { S.pick = OWNER; S.draft = ""; S.code = ""; S.codeWrong = false; render(); focusCode(); return; }
    if (S.checking) return;
    var code = S.code.trim();
    if (!code) { focusCode(); return; }
    S.checking = true;
    var ok = false;
    try { ok = (await sha(CODE_SALT + code)) === OWNER_HASH; } catch (e) {}
    S.checking = false;
    if (ok) { store.set("wl-owner", OWNER_HASH); S.code = ""; S.codeWrong = false; signIn(OWNER, false); }
    else { S.code = ""; S.codeWrong = true; render(); focusCode(); }
  }

  function signOut() {
    store.set("wl-owner", "");
    if (stopClaims) { stopClaims(); stopClaims = null; }
    clearTimeout(timer);
    claims = []; S.status = "idle"; S.flash = {}; S.busy = null;
    S.edit = null; S.confirm = null; S.editFlash = "";
    S.name = ""; store.set("wl-name", "");
    render();
  }

  /* ---------- views ---------- */

  function loginView() {
    var names = knownNames();
    var isNew = S.pick === "__new";
    var form = h("form", { onsubmit: function (e) {
      e.preventDefault();
      var v = (isNew ? S.draft : S.pick).trim().slice(0, 30);
      if (!v || v === "__new") return;
      var match = names.filter(function (n) { return same(n, v); })[0];
      if (match && same(match, OWNER)) { ownerSubmit(); return; }
      signIn(match || v, !match);
    } },
      h("div", { class: "field" },
        h("label", { for: "name-select", text: "Your name" }),
        h("select", { id: "name-select", onchange: function (e) {
            S.pick = e.target.value; S.code = ""; S.codeWrong = false; render();
            var i = document.getElementById(S.pick === "__new" ? "name-input" : S.pick === OWNER ? "owner-code" : "name-select");
            if (i) i.focus();
          } },
          h("option", { value: "", text: "Choose your name" }),
          names.map(function (n) { return h("option", { value: n, text: n }); }),
          h("option", { value: "__new", text: "Someone new" })
        )
      ),
      isNew && h("div", { class: "field" },
        h("label", { for: "name-input", text: "Type your name" }),
        h("input", { id: "name-input", type: "text", maxlength: "30", autocomplete: "given-name",
          oninput: function (e) { S.draft = e.target.value; } })
      ),
      S.pick === OWNER && h("div", { class: "field" },
        h("label", { for: "owner-code", text: "Passcode" }),
        h("input", { id: "owner-code", type: "password", inputmode: "numeric", maxlength: "4", autocomplete: "off",
          oninput: function (e) { S.code = e.target.value; } }),
        S.codeWrong && h("p", { class: "flash", text: "That passcode isn't right." })
      ),
      h("button", { class: "btn", type: "submit", text: "Continue" })
    );
    return h("section", { class: "login" },
      h("h1", { text: "Who's here?" }),
      form,
      h("p", { class: "hint", text: "Pick your name to see the list. If you've been here before, it's in the dropdown." })
    );
  }

  function notices() {
    var out = [];
    function say(text, warn) { out.push(h("p", { class: "notice" + (warn ? " warn" : ""), text: text })); }
    if (S.itemsStatus === "loading") say("Loading the list…");
    else if (S.itemsStatus === "slow") say("Can't reach the list yet. Check your connection and give it a moment.", true);
    else if (S.itemsStatus === "error") say("The list couldn't load. Check your connection and reload the page.", true);
    else if (isOwner()) { if (S.editFlash) say(S.editFlash, true); }
    else if (S.status === "loading") say("Checking what's already taken…");
    else if (S.status === "slow") say("Can't reach the picks yet. Hold off on buying until this loads.", true);
    else if (S.status === "error") say("The picks stopped loading. Reload the page before you buy anything.", true);
    return out;
  }

  function editorForm() {
    var e = S.edit;
    return h("form", { class: "editor", onsubmit: saveEdit },
      h("div", { class: "field" },
        h("label", { for: "item-title", text: "Item" }),
        h("input", { id: "item-title", type: "text", maxlength: "120",
          oninput: function (ev) { e.title = ev.target.value; } })
      ),
      h("div", { class: "field" },
        h("label", { for: "item-details", text: "Details (optional)" }),
        h("textarea", { id: "item-details", rows: "4", maxlength: "2000",
          oninput: function (ev) { e.details = ev.target.value; } })
      ),
      h("p", { class: "hint", text: "Start lines with 1. or - to make a list. Write [words](https://link) to turn just those words into a link. Wrap words in *asterisks* for italics." }),
      h("label", { class: "check", for: "item-shared" },
        h("input", { id: "item-shared", type: "checkbox",
          onchange: function (ev) { e.shared = ev.target.checked; } }),
        "More than one person can give this"
      ),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "submit", text: e.id ? "Save" : "Add to list", disabled: S.saving }),
        h("button", { class: "link", type: "button", text: "Cancel",
          onclick: function () { S.edit = null; render(); } })
      )
    );
  }

  function ownerTools(item, index) {
    var box = h("div", { class: "claim" });
    if (!canEdit() || S.edit) return box;
    if (S.confirm === item.id) {
      box.append(h("p", { class: "status", text: "Remove this from the list?" }),
        h("div", { class: "tools" },
          h("button", { class: "link", type: "button", text: "Remove", disabled: S.saving, onclick: function () { removeItem(item); } }),
          h("button", { class: "link", type: "button", text: "Keep", onclick: function () { S.confirm = null; render(); } })));
      return box;
    }
    box.append(h("div", { class: "tools" },
      h("button", { class: "link", type: "button", text: "Edit", onclick: function () {
        S.edit = { id: item.id, title: item.title, details: item.details, shared: item.shared };
        S.confirm = null; render();
        var t = document.getElementById("item-title"); if (t) t.focus();
      } }),
      index > 0 && h("button", { class: "link", type: "button", text: "Move up", disabled: S.saving, onclick: function () { move(index, -1); } }),
      index < items.length - 1 && h("button", { class: "link", type: "button", text: "Move down", disabled: S.saving, onclick: function () { move(index, 1); } }),
      h("button", { class: "link", type: "button", text: "Remove", onclick: function () { S.confirm = item.id; render(); } })
    ));
    return box;
  }

  function pickBox(item) {
    var cs = claims.filter(function (c) { return c.item === item.id; });
    var act = canAct();
    var mine = cs.filter(isMine)[0];
    var taken = !item.shared && cs.length > 0;
    var box = h("div", { class: "claim" });
    if (cs.length) {
      var others = cs.length - (mine ? 1 : 0);
      box.append(h("p", { class: "status", text: item.shared
        ? sharedStatus(!!mine, others)
        : (mine ? "Taken by you" : "Taken") }));
    }
    if (act && mine) {
      box.append(h("button", { class: "link", type: "button", text: "Undo my pick",
        disabled: S.busy === item.id, onclick: function () { release(mine); } }));
    }
    if (act && !taken && !mine) {
      box.append(h("button", { class: "act", type: "button",
        text: item.cta || (item.shared ? "I'll chip in" : "I'll get this"),
        disabled: S.busy === item.id, onclick: function () { claim(item); } }));
    }
    if (S.flash[item.id]) box.append(h("p", { class: "flash", text: S.flash[item.id] }));
    return { box: box, taken: taken };
  }

  function renderItem(item, index) {
    if (S.edit && S.edit.id === item.id) return h("li", { class: "row editing" }, editorForm());
    var head = h("h3"); inline(head, item.title);
    var wish = h("div", { class: "wish" }, head, detailNodes(item.details));
    if (isOwner()) return h("li", { class: "row" }, wish, ownerTools(item, index));
    var p = pickBox(item);
    return h("li", { class: "row" + (p.taken ? " taken" : "") }, wish, p.box);
  }

  function listView() {
    var out = [];
    out.push(h("div", { class: "whoami" },
      h("span", { text: "Signed in as " + S.name }),
      h("button", { class: "act", type: "button", text: "Switch name", onclick: signOut })));
    out.push(h("p", { class: "intro" + (isOwner() ? " owner" : ""), text: isOwner()
      ? "You're signed in as yourself, so anything that's been taken is hidden from you. You can change the list here, and everyone sees your changes."
      : "Press the button on anything you plan to give. It then shows as taken for everyone else, without your name, so nothing gets bought twice. Roman can't see any of it." }));
    out = out.concat(notices());
    if (S.itemsStatus !== "ready" && !items.length) return out;
    out.push(h("h2", { class: "section", text: "Christmas 2026" }));
    if (!items.length) out.push(h("p", { class: "notice", text: "Nothing on the list yet." }));
    var rows = items.map(renderItem);
    if (S.edit && !S.edit.id) rows.push(h("li", { class: "row editing" }, editorForm()));
    if (rows.length) out.push(h("ul", { class: "rows" }, rows));
    if (canEdit() && !S.edit) {
      out.push(h("button", { class: "act", type: "button", text: "Add an item", onclick: function () {
        S.edit = { id: null, title: "", details: "", shared: false };
        S.confirm = null; render();
        var t = document.getElementById("item-title"); if (t) t.focus();
      } }));
    }
    return out;
  }

  var KEEP_FOCUS = { "owner-code": 1, "name-input": 1, "name-select": 1, "item-title": 1, "item-details": 1, "item-shared": 1 };

  function render() {
    var active = document.activeElement;
    var focusId = active && KEEP_FOCUS[active.id] ? active.id : null;
    var caret = null;
    try { if (focusId && typeof active.selectionStart === "number") caret = [active.selectionStart, active.selectionEnd]; } catch (e) {}

    var app = document.getElementById("app");
    app.replaceChildren.apply(app, S.name ? listView() : [loginView()]);

    var el;
    if ((el = document.getElementById("name-select"))) el.value = S.pick;
    if ((el = document.getElementById("name-input"))) el.value = S.draft;
    if ((el = document.getElementById("owner-code"))) el.value = S.code;
    if (S.edit) {
      if ((el = document.getElementById("item-title"))) el.value = S.edit.title;
      if ((el = document.getElementById("item-details"))) el.value = S.edit.details;
      if ((el = document.getElementById("item-shared"))) el.checked = !!S.edit.shared;
    }
    var back = focusId && document.getElementById(focusId);
    if (back) {
      back.focus();
      try { if (caret) back.setSelectionRange(caret[0], caret[1]); } catch (e) {}
    }
  }

  /* ---------- picks ---------- */

  async function claim(item) {
    if (!canAct()) return;
    S.busy = item.id; delete S.flash[item.id]; render();
    var body = { item: item.id, name: S.name, at: new Date().toISOString() };
    try {
      if (item.shared) {
        await S.db.collection("claims").add(body);
      } else {
        // The doc id is the item id and the rules refuse overwrites, so if two
        // people press at once only the first one lands.
        await S.db.collection("claims").doc(item.id).set(body);
      }
    } catch (e) {
      S.flash[item.id] = (e && e.code === "permission-denied" && !item.shared)
        ? "Someone just took this one."
        : "That didn't save. Try again in a moment.";
    }
    S.busy = null; render();
  }

  async function release(c) {
    if (!canAct()) return;
    S.busy = c.item; delete S.flash[c.item]; render();
    try { await S.db.collection("claims").doc(c.id).delete(); }
    catch (e) { S.flash[c.item] = "That didn't save. Try again in a moment."; }
    S.busy = null; render();
  }

  /* ---------- Roman's changes to the list ---------- */

  function editFail() { S.editFlash = "That didn't save. Try again in a moment."; }

  async function saveEdit(ev) {
    ev.preventDefault();
    var e = S.edit;
    if (!e || S.saving || !canEdit()) return;
    var title = e.title.trim().slice(0, 120);
    if (!title) { var t = document.getElementById("item-title"); if (t) t.focus(); return; }
    S.saving = true; S.editFlash = ""; render();
    var body = { title: title, details: e.details.trim().slice(0, 2000), shared: !!e.shared };
    try {
      if (e.id) {
        await S.db.collection("items").doc(e.id).update(body);
      } else {
        body.order = items.reduce(function (m, i) { return Math.max(m, i.order); }, 0) + 1;
        var id = slug(title).slice(0, 40) + "-" + Math.random().toString(36).slice(2, 6);
        await S.db.collection("items").doc(id).set(body);
      }
      S.edit = null;
    } catch (err) { editFail(); }
    S.saving = false; render();
  }

  async function move(index, dir) {
    var a = items[index], b = items[index + dir];
    if (!a || !b || S.saving || !canEdit()) return;
    S.saving = true; S.editFlash = ""; render();
    try {
      var batch = S.db.batch();
      batch.update(S.db.collection("items").doc(a.id), { order: b.order });
      batch.update(S.db.collection("items").doc(b.id), { order: a.order });
      await batch.commit();
    } catch (err) { editFail(); }
    S.saving = false; render();
  }

  async function removeItem(item) {
    if (S.saving || !canEdit()) return;
    S.saving = true; S.editFlash = ""; render();
    try { await S.db.collection("items").doc(item.id).delete(); }
    catch (err) { editFail(); }
    S.confirm = null; S.saving = false; render();
  }

  /* ---------- start ---------- */

  render();

  try {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    S.db = firebase.firestore();
  } catch (e) {
    S.itemsStatus = "error"; render(); return;
  }

  var itemsTimer = setTimeout(function () {
    if (S.itemsStatus === "loading") { S.itemsStatus = "slow"; render(); }
  }, 10000);
  S.db.collection("items").onSnapshot(function (snap) {
    var live = cleanItems(snap.docs.map(function (d) {
      var x = d.data() || {};
      return { id: d.id, title: x.title, details: x.details, shared: x.shared, cta: x.cta, order: x.order };
    }));
    if (live.length || !snap.metadata.fromCache) items = live;
    if (!snap.metadata.fromCache) { clearTimeout(itemsTimer); S.itemsStatus = "ready"; }
    render();
  }, function () { clearTimeout(itemsTimer); S.itemsStatus = "error"; render(); });

  S.db.collection("people").onSnapshot(function (snap) {
    people = snap.docs.map(function (d) { return (d.data() || {}).name; })
      .filter(function (n) { return typeof n === "string" && n.trim(); })
      .map(function (n) { return n.trim().slice(0, 30); })
      .sort(function (a, b) { return a.localeCompare(b); });
    if (!S.name) render();
  }, function () {});

  startClaims();
})();
