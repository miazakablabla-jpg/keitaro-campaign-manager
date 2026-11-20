/* global $ */
(function () {
  "use strict";

  // =====================================================================
  // Состояние
  // =====================================================================
  var S = {
    meta: { fake_keitaro: true, keitaro_admin_url: null, geo_redirect_url: "https://google.com" },
    refs: { domains: [], groups: [], sources: [] },
    refsLoaded: false,
    campaigns: [],
    campaignsError: null,
    campaign: null,       // CampaignOut из локальной базы
    stats: null,          // ответ /stats
    statsLoading: false,
    statsError: null,
    period: store("period") || "7d",
    scope: store("scope") || "mine",   // mine | all — фильтр списка кампаний
    busy: false,
  };

  var PERIODS = [
    ["today", "Сегодня"], ["yesterday", "Вчера"], ["7d", "7 дней"],
    ["30d", "30 дней"], ["month", "Этот месяц"], ["all", "Всё время"],
  ];

  // =====================================================================
  // Утилиты
  // =====================================================================
  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem("kcm." + key);
      window.localStorage.setItem("kcm." + key, value);
    } catch (e) { /* приватный режим */ }
    return null;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  };
  function icon(name) {
    return '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + "</svg>";
  }

  var nfInt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  var nfMoney = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var nfCompact = new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 });
  function fInt(n) { return nfInt.format(Math.round(n || 0)); }
  function fBig(n) { return Math.abs(n) >= 100000 ? nfCompact.format(n) : fInt(n); }
  function fMoney(n) { return nfMoney.format(n || 0); }
  function fPct(part, whole) {
    if (!whole) return "—";
    var v = (part / whole) * 100;
    return v.toLocaleString("ru-RU", { maximumFractionDigits: v < 10 ? 2 : 1 }) + "%";
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  function errText(xhr) {
    if (!xhr || xhr.status === 0) return "Сервер приложения недоступен";
    var d = xhr.responseJSON && xhr.responseJSON.detail;
    if (Array.isArray(d)) return d.map(function (e) { return e.msg; }).join("; ");
    return (typeof d === "string" ? d : d && JSON.stringify(d)) || xhr.statusText || "Ошибка";
  }

  function api(method, url, body, opts) {
    return $.ajax({
      method: method,
      url: url,
      contentType: "application/json",
      data: body === undefined ? undefined : JSON.stringify(body),
      dataType: "json",
    }).fail(function (xhr) {
      if (!(opts && opts.silent)) toast(errText(xhr), "error");
    });
  }

  function toast(text, kind) {
    kind = kind || "ok";
    var $t = $('<div class="toast ' + kind + '" role="status">' + icon(kind === "error" ? "alert" : "check") + "<span></span></div>");
    $t.find("span").text(text);
    $("#toasts").append($t);
    setTimeout(function () { $t.fadeOut(200, function () { $t.remove(); }); }, kind === "error" ? 7000 : 3500);
  }

  function copyText(text) {
    var done = function () { toast("Ссылка скопирована"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { toast(text); });
    } else {
      toast(text);
    }
  }

  // Модальные окна вместо window.confirm/prompt
  function dialog(opts) {
    return new Promise(function (resolve) {
      var d = document.getElementById("dialog");
      var $d = $(d);
      $d.find(".dialog-title").text(opts.title);
      $d.find(".dialog-text").text(opts.text || "").prop("hidden", !opts.text);
      var $field = $d.find(".dialog-field").prop("hidden", !opts.prompt);
      var $in = $field.find("input").val(opts.value || "");
      $field.find(".field-label").text(opts.label || "");
      $d.find('[value="ok"]').text(opts.ok || "OK").toggleClass("btn-danger", !!opts.danger).toggleClass("btn-primary", !opts.danger);
      $d.find('[value="cancel"]').text(opts.cancel || "Отмена");
      d.returnValue = "";
      $in.off("keydown.dlg").on("keydown.dlg", function (e) {
        if (e.key === "Enter") { e.preventDefault(); d.close("ok"); }
      });
      $d.off("close.dlg").one("close.dlg", function () {
        var ok = d.returnValue === "ok";
        resolve(opts.prompt ? (ok ? $.trim($in.val()) || null : null) : ok);
      });
      d.showModal();
      setTimeout(function () { (opts.prompt ? $in : $d.find('[value="ok"]')).trigger("focus"); }, 0);
    });
  }

  // В Keitaro название оффера часто уже начинается с его ID («18813 Flexacil…») — не дублируем.
  function offerName(id, name) {
    var p = String(id) + " ";
    name = String(name || "");
    return name.indexOf(p) === 0 ? name.slice(p.length) : name;
  }

  function keitaroCampaignLink(id) {
    return S.meta.keitaro_admin_url ? S.meta.keitaro_admin_url + "#!/campaigns/" + id : null;
  }

  function dirtyStreams(c) {
    return c ? c.streams.filter(function (s) { return s.is_dirty; }) : [];
  }

  // Автокомплит офферов: jQuery UI → /api/offers/search → GET /offers в Keitaro
  function offerAutocomplete($input, onSelect) {
    $input.autocomplete({
      minLength: 0,
      delay: 180,
      source: function (req, res) {
        $.getJSON("/api/offers/search", { q: req.term })
          .done(function (rows) {
            if (!rows.length) { res([{ label: "Ничего не найдено", value: "", empty: true }]); return; }
            res(rows.map(function (o) { var t = "[" + o.id + "] " + offerName(o.id, o.name); return { label: t, value: t, offer: o }; }));
          })
          .fail(function () { res([{ label: "Не удалось загрузить офферы", value: "", empty: true }]); });
      },
      select: function (e, ui) {
        if (!ui.item.offer) { e.preventDefault(); return; }
        onSelect(ui.item.offer);
      },
      focus: function (e, ui) { if (!ui.item.offer) e.preventDefault(); },
    }).on("focus", function () { $(this).autocomplete("search", $(this).val()); });
    $input.autocomplete("instance")._renderItem = function (ul, item) {
      var html = item.empty
        ? '<span class="ac-empty">' + esc(item.label) + "</span>"
        : '<span class="ac-id">' + item.offer.id + "</span>" + esc(offerName(item.offer.id, item.offer.name));
      return $("<li>").toggleClass("ui-state-disabled", !!item.empty).append($("<div>").html(html)).appendTo(ul);
    };
  }

  // =====================================================================
  // Боковая панель
  // =====================================================================
  function loadCampaigns() {
    return api("GET", "/api/keitaro/campaigns", undefined, { silent: true })
      .done(function (rows) { S.campaigns = rows; S.campaignsError = null; renderSidebar(); })
      .fail(function (xhr) { S.campaignsError = errText(xhr); renderSidebar(); setConn("down"); });
  }

  function renderSidebar() {
    var q = $.trim($("#campaign-search").val()).toLowerCase();
    var route = parseHash();
    var prefix = S.meta.campaign_prefix;
    var mineOnly = prefix && S.scope === "mine";
    var mineCount = S.campaigns.filter(function (c) { return c.mine; }).length;
    $("#scope").prop("hidden", !prefix).find("button").each(function () {
      var v = $(this).data("scope");
      $(this).toggleClass("active", v === S.scope).text(v === "mine" ? "Мои · " + mineCount : "Все · " + S.campaigns.length);
    });
    var rows = S.campaigns.filter(function (c) {
      if (mineOnly && !c.mine) return false;
      return !q || String(c.id) === q || c.name.toLowerCase().indexOf(q) !== -1 || String(c.alias || "").toLowerCase().indexOf(q) !== -1;
    });
    var $list = $("#campaign-list").empty();
    if (S.campaignsError) {
      $list.append('<li class="list-empty">Не удалось загрузить кампании: ' + esc(S.campaignsError) + "</li>");
      return;
    }
    if (!rows.length) {
      $list.append('<li class="list-empty">' + (q ? "Ничего не найдено" : mineOnly ? "Своих кампаний пока нет. Создайте первую — название начнётся с «" + esc(prefix) + "»." : "В трекере пока нет кампаний") + "</li>");
      return;
    }
    rows.forEach(function (c) {
      var active = route.name === "campaign" && route.id === c.id;
      $list.append(
        '<li><a href="#/campaign/' + c.id + '" class="' + (active ? "active" : "") + '">' +
          '<span class="c-name" title="' + esc(c.name) + '">' + esc(c.name) + "</span>" +
          '<span class="c-flag ' + (c.imported ? "loaded" : "") + '">' + (!c.mine ? "чужая" : c.imported ? "загружена" : "") + "</span>" +
          '<span class="c-meta">#' + c.id + (c.alias ? " · " + esc(c.alias) : "") + "</span>" +
        "</a></li>"
      );
    });
  }

  function setConn(state) {
    var $c = $("#conn").prop("hidden", false).removeClass("demo down");
    if (state === "down") { $c.addClass("down").text("Нет связи с Keitaro"); return; }
    if (S.meta.fake_keitaro) { $c.addClass("demo").text("Демо-режим: эмулятор Keitaro"); return; }
    var host = (S.meta.keitaro_admin_url || "").replace(/^https?:\/\//, "").replace(/\/admin\/?$/, "");
    $c.text("Keitaro: " + host);
  }

  $("#campaign-search").on("input", renderSidebar);
  $("#scope").on("click", "button", function () {
    S.scope = $(this).data("scope");
    store("scope", S.scope);
    renderSidebar();
  });
  $("#reload-campaigns").on("click", function () {
    var $b = $(this).prop("disabled", true);
    loadCampaigns().done(function () { toast("Список кампаний обновлён"); }).always(function () { $b.prop("disabled", false); });
  });

  // =====================================================================
  // Маршрутизация: #/new, #/campaign/<id>
  // =====================================================================
  function parseHash() {
    var m = location.hash.match(/^#\/campaign\/(\d+)/);
    return m ? { name: "campaign", id: Number(m[1]) } : { name: "new" };
  }

  var lastHash = location.hash || "#/new";
  window.addEventListener("hashchange", function () {
    var next = parseHash();
    var dirty = dirtyStreams(S.campaign);
    var leaving = S.campaign && !(next.name === "campaign" && next.id === S.campaign.id);
    if (leaving && dirty.length) {
      var target = location.hash;
      history.replaceState(null, "", lastHash);
      dialog({
        title: "Есть неопубликованные изменения",
        text: "В кампании «" + S.campaign.name + "» не опубликовано " + dirty.length + " " + plural(dirty.length, "поток", "потока", "потоков") +
          ". Черновик сохранится в приложении, но в Keitaro изменения не попадут, пока вы их не опубликуете.",
        ok: "Перейти", cancel: "Остаться",
      }).then(function (ok) {
        if (!ok) return;
        S.campaign = null;
        history.replaceState(null, "", target);
        lastHash = target;
        route();
      });
      return;
    }
    lastHash = location.hash;
    route();
  });

  window.addEventListener("beforeunload", function (e) {
    if (dirtyStreams(S.campaign).length) { e.preventDefault(); e.returnValue = ""; }
  });

  function route() {
    var r = parseHash();
    renderSidebar();
    $("#view").scrollTop(0);
    if (r.name === "campaign") openCampaign(r.id);
    else { S.campaign = null; renderCreate(); }
  }

  // =====================================================================
  // Часть 1. Новая кампания
  // =====================================================================
  var C = { geo: [], offer: null, submitting: false };

  function optionList(rows) {
    if (!rows.length) return '<option value="">— нет в Keitaro —</option>';
    return rows.map(function (r) { return '<option value="' + r.id + '">' + esc(r.name) + "</option>"; }).join("");
  }

  function renderCreate() {
    C = { geo: [], offer: null, submitting: false };
    var target = S.meta.geo_redirect_url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    $("#view").html(
      '<div class="view-inner">' +
        '<div class="page-head"><div>' +
          '<div class="crumbs">Кампании</div><h1>Новая кампания</h1>' +
          '<div class="meta-row">Кампания создаётся в Keitaro сразу с двумя потоками: посетители из выбранных стран уходят на ' + esc(target) + ", остальные — на оффер.</div>" +
        "</div></div>" +
        '<div class="create-grid">' +
          '<form id="create-form" class="card" novalidate autocomplete="off">' +
            '<div class="form-section"><h2>Основное</h2>' +
              '<label class="field"><span class="field-label">Название</span>' +
                (S.meta.campaign_prefix
                  ? '<span class="input-group"><span class="addon" title="Обязательный префикс по правилам теста">' + esc(S.meta.campaign_prefix) + '</span><input class="input" name="name" maxlength="240" placeholder="campaign1"></span>'
                  : '<input class="input" name="name" maxlength="255" placeholder="Например, RO beauty — ноябрь">') +
                (S.meta.campaign_prefix ? '<span class="field-hint">Префикс подставится сам — так требуют правила тестового трекера.</span>' : "") +
                '<span class="field-error" data-err="name" hidden></span></label>' +
            "</div>" +
            '<div class="form-section"><h2>Таргетинг</h2>' +
              '<div class="field"><span class="field-label">Гео для редиректа на ' + esc(target) + "</span>" +
                '<div class="chips" id="geo-chips"><input id="geo-input" placeholder="Страна или код: Мексика, AU, RO"></div>' +
                '<span class="field-hint">Поиск по названию или коду ISO. Можно вставить список через запятую. Backspace удаляет последнюю страну.</span>' +
                '<span class="field-error" data-err="geo" hidden></span></div>' +
              '<div class="field"><span class="field-label">Оффер для остального трафика</span>' +
                '<div id="offer-slot"></div>' +
                '<span class="field-error" data-err="offer" hidden></span></div>' +
            "</div>" +
            '<div class="form-section"><h2>Размещение</h2>' +
              '<div class="row3">' +
                '<label class="field"><span class="field-label">Домен</span><select class="input" name="domain_id">' + optionList(S.refs.domains) + "</select></label>" +
                '<div class="field"><span class="field-label">Группа</span><div class="with-action"><select class="input" name="group_id">' + optionList(S.refs.groups) + '</select><button type="button" class="icon-btn" data-create="groups" title="Создать группу в Keitaro" aria-label="Создать группу">' + icon("plus") + "</button></div></div>" +
                '<div class="field"><span class="field-label">Источник</span><div class="with-action"><select class="input" name="traffic_source_id">' + optionList(S.refs.sources) + '</select><button type="button" class="icon-btn" data-create="sources" title="Создать источник в Keitaro" aria-label="Создать источник">' + icon("plus") + "</button></div></div>" +
              "</div>" +
              '<span class="field-error" data-err="refs" hidden></span>' +
            "</div>" +
            '<div class="form-foot"><button type="reset" class="btn btn-ghost">Очистить</button><button type="submit" class="btn btn-primary">' + icon("plus") + "Создать кампанию</button></div>" +
          "</form>" +
          '<aside class="card preview"><div class="card-head"><h2>Что будет создано</h2></div><div class="card-body" id="preview"></div></aside>' +
        "</div>" +
      "</div>"
    );
    renderOfferSlot();
    bindGeo();
    restoreRefs();
    renderPreview();
    if (!S.refsLoaded) loadRefs().done(function () { if (parseHash().name === "new") refillRefs(); });
  }

  function refillRefs() {
    var $f = $("#create-form");
    $f.find("[name=domain_id]").html(optionList(S.refs.domains));
    $f.find("[name=group_id]").html(optionList(S.refs.groups));
    $f.find("[name=traffic_source_id]").html(optionList(S.refs.sources));
    restoreRefs();
    renderPreview();
  }

  // Последние выбранные домен, группа и источник подставляются по умолчанию.
  var REF_FIELDS = ["domain_id", "group_id", "traffic_source_id"];
  function restoreRefs() {
    REF_FIELDS.forEach(function (f) {
      var v = store("ref." + f);
      var $sel = $("#create-form [name=" + f + "]");
      if (v && $sel.find('option[value="' + v + '"]').length) $sel.val(v);
    });
  }
  $("#view").on("change", "#create-form select", function () { store("ref." + this.name, this.value); });

  function renderOfferSlot() {
    var $slot = $("#offer-slot");
    if (C.offer) {
      $slot.html(
        '<div class="picked"><span class="offer-id">' + C.offer.id + '</span><span class="offer-name">' + esc(offerName(C.offer.id, C.offer.name)) + "</span>" +
        '<button type="button" class="icon-btn" id="offer-clear" title="Выбрать другой оффер" aria-label="Выбрать другой оффер">' + icon("x") + "</button></div>"
      );
    } else {
      $slot.html('<input class="input" id="create-offer" placeholder="ID или название оффера">');
      offerAutocomplete($("#create-offer"), function (offer) {
        C.offer = offer;
        setTimeout(function () { renderOfferSlot(); renderPreview(); fieldError("offer", ""); }, 0);
      });
    }
  }

  function fieldError(name, text) {
    $('[data-err="' + name + '"]').text(text || "").prop("hidden", !text);
    if (name === "name") $("#create-form [name=name]").toggleClass("invalid", !!text);
    if (name === "geo") $("#geo-chips").toggleClass("invalid", !!text);
    if (name === "offer") $("#create-offer").toggleClass("invalid", !!text);
  }

  function selText(name) {
    var $o = $("#create-form [name=" + name + "] option:selected");
    return $o.val() ? $o.text() : "";
  }

  function fullName(raw) {
    var p = S.meta.campaign_prefix || "";
    raw = $.trim(raw || "");
    if (!raw) return "";
    return p && raw.indexOf(p) !== 0 ? p + raw : raw;
  }

  function renderPreview() {
    var name = fullName($("#create-form [name=name]").val());
    var domain = selText("domain_id");
    var geo = C.geo.length
      ? C.geo.map(function (c) { var x = window.COUNTRY_BY_CODE[c]; return esc(c) + (x && x.name !== c ? ' <span class="muted">' + esc(x.name) + "</span>" : ""); }).join(", ")
      : '<span class="pv-empty">страны не выбраны</span>';
    var none = function (t) { return t ? esc(t) : '<span class="pv-empty">не выбрано</span>'; };
    $("#preview").html(
      '<div class="pv-row"><span class="pv-label">Кампания</span><span>' + (name ? esc(name) : '<span class="pv-empty">без названия</span>') + "</span></div>" +
      '<div class="pv-row"><span class="pv-label">Ссылка</span><code>' + esc(domain ? (/^https?:/.test(domain) ? domain : "https://" + domain).replace(/\/$/, "") : "https://домен") + '/<span class="muted">алиас</span></code></div>' +
      '<div class="pv-flow"><div class="pv-flow-title"><span class="pos">1</span>Гео → редирект</div>' +
        '<div>' + geo + '</div><div class="muted small">Фильтр «Страна, принимать» · ' + esc(S.meta.geo_redirect_url) + "</div></div>" +
      '<div class="pv-flow"><div class="pv-flow-title"><span class="pos">2</span>Остальной трафик → оффер</div>' +
        "<div>" + (C.offer ? '<span class="offer-id">' + C.offer.id + "</span> " + esc(offerName(C.offer.id, C.offer.name)) : '<span class="pv-empty">оффер не выбран</span>') + '</div><div class="muted small">Без фильтров · доля 100%</div></div>' +
      '<div class="pv-row"><span class="pv-label">Группа · Источник</span><span>' + none(selText("group_id")) + " · " + none(selText("traffic_source_id")) + "</span></div>"
    );
  }

  // --- Гео-чипсы ---
  function bindGeo() {
    var $chips = $("#geo-chips");
    var $in = $("#geo-input");

    function renderChips() {
      $chips.find(".chip").remove();
      C.geo.forEach(function (code) {
        var c = window.COUNTRY_BY_CODE[code];
        $('<span class="chip"><span class="code"></span><span class="name"></span><button type="button" aria-label="Убрать страну">' + icon("x") + "</button></span>")
          .find(".code").text(code).end()
          .find(".name").text(c && c.name !== code ? c.name : "").end()
          .find("button").attr("data-code", code).end()
          .insertBefore($in);
      });
      renderPreview();
    }

    function add(code) {
      code = String(code || "").trim().toUpperCase();
      if (!window.COUNTRY_BY_CODE[code]) return false;
      if (C.geo.indexOf(code) === -1) C.geo.push(code);
      fieldError("geo", "");
      renderChips();
      return true;
    }

    // «mx, au;RO», «Южная Корея», «MX AU» → чипсы; нераспознанное остаётся в поле
    function consume(text) {
      var rest = [];
      text.split(/[,;\n]+/).forEach(function (chunk) {
        chunk = chunk.trim();
        if (!chunk) return;
        var parts = byName(chunk) || window.COUNTRY_BY_CODE[chunk.toUpperCase()] ? [chunk] : chunk.split(/\s+/);
        parts.forEach(function (p) {
          var hit = byName(p);
          if (!add(p) && !(hit && add(hit.code))) rest.push(p);
        });
      });
      return rest.join(" ");
    }
    function byName(t) {
      t = t.toLowerCase();
      return window.COUNTRIES.filter(function (c) { return c.name.toLowerCase() === t; })[0];
    }

    $in.autocomplete({
      minLength: 1,
      delay: 0,
      autoFocus: true,
      source: function (req, res) {
        var q = req.term.trim().toLowerCase();
        var rank = function (c) { return c.code.toLowerCase() === q ? 0 : c.name.toLowerCase().indexOf(q) === 0 ? 1 : 2; };
        var rows = window.COUNTRIES.filter(function (c) {
          return C.geo.indexOf(c.code) === -1 && (c.code.toLowerCase() === q || c.name.toLowerCase().indexOf(q) !== -1);
        }).sort(function (a, b) { return rank(a) - rank(b); });
        res(rows.slice(0, 12).map(function (c) { return { label: c.name, value: "", code: c.code }; }));
      },
      select: function (e, ui) { e.preventDefault(); add(ui.item.code); $in.val(""); },
      focus: function (e) { e.preventDefault(); },
    });
    $in.autocomplete("instance")._renderItem = function (ul, item) {
      return $("<li>").append($("<div>").html('<span class="ac-id">' + item.code + "</span>" + esc(item.label))).appendTo(ul);
    };
    $in.on("keydown", function (e) {
      if (e.key === "Backspace" && !this.value && C.geo.length) { C.geo.pop(); renderChips(); return; }
      var sep = e.key === "," || e.key === ";";
      var enter = e.key === "Enter" && !$in.autocomplete("widget").is(":visible");
      if (sep || enter) {
        e.preventDefault();
        if (this.value.trim()) this.value = consume(this.value);
        $in.autocomplete("close");
      }
    });
    $in.on("paste", function () {
      var el = this;
      setTimeout(function () { el.value = consume(el.value); $in.autocomplete("close"); }, 0);
    });
    $in.on("blur", function () { if (this.value.trim()) this.value = consume(this.value); });
    $chips.on("click", "button[data-code]", function () {
      var code = $(this).attr("data-code");
      C.geo = C.geo.filter(function (c) { return c !== code; });
      renderChips();
    });
    $chips.on("click", function (e) { if (e.target === this) $in.trigger("focus"); });
    C.consumeGeo = consume;
    C.renderChips = renderChips;
  }

  function loadRefs() {
    return api("GET", "/api/refs", undefined, { silent: true })
      .done(function (refs) { S.refs = refs; S.refsLoaded = true; fieldError("refs", ""); })
      .fail(function (xhr) { fieldError("refs", "Не удалось загрузить домены, группы и источники: " + errText(xhr)); setConn("down"); });
  }

  $("#view").on("input change", "#create-form [name]", renderPreview);
  $("#view").on("input", "#create-form [name=name]", function () {
    // если префикс вставили вручную — убираем, он уже стоит слева
    var p = S.meta.campaign_prefix;
    if (p && this.value.indexOf(p) === 0) this.value = this.value.slice(p.length);
    fieldError("name", "");
  });
  $("#view").on("click", "#offer-clear", function () { C.offer = null; renderOfferSlot(); renderPreview(); $("#create-offer").trigger("focus"); });
  $("#view").on("reset", "#create-form", function () {
    setTimeout(function () {
      C.geo = []; C.offer = null;
      if (C.renderChips) C.renderChips();
      renderOfferSlot(); renderPreview();
      ["name", "geo", "offer"].forEach(function (f) { fieldError(f, ""); });
    }, 0);
  });

  $("#view").on("click", "[data-create]", function () {
    var kind = $(this).data("create");
    dialog({
      title: kind === "groups" ? "Новая группа кампаний" : "Новый источник трафика",
      label: "Название", prompt: true, ok: "Создать в Keitaro",
    }).then(function (name) {
      if (!name) return;
      api("POST", "/api/refs/" + kind, { name: name }).done(function (row) {
        var key = kind === "groups" ? "groups" : "sources";
        S.refs[key].push(row);
        var $sel = $("#create-form [name=" + (kind === "groups" ? "group_id" : "traffic_source_id") + "]");
        $sel.html(optionList(S.refs[key])).val(String(row.id));
        renderPreview();
        toast("Создано в Keitaro: " + row.name);
      });
    });
  });

  $("#view").on("submit", "#create-form", function (e) {
    e.preventDefault();
    if (C.submitting) return;
    var $f = $(this);
    var $geoIn = $("#geo-input");
    if ($.trim($geoIn.val()) && C.consumeGeo) $geoIn.val(C.consumeGeo($geoIn.val()));

    var name = $.trim($f.find("[name=name]").val());
    var typed = $.trim($("#create-offer").val() || "");
    var offerId = C.offer ? C.offer.id : (/^\d+$/.test(typed) ? Number(typed) : null);
    var ids = ["domain_id", "group_id", "traffic_source_id"].map(function (n) { return Number($f.find("[name=" + n + "]").val()) || null; });

    var ok = true;
    fieldError("name", name ? "" : "Укажите название"); ok = ok && !!name;
    var leftover = $.trim($geoIn.val());
    var geoErr = leftover ? "Не распознано: «" + leftover + "». Выберите страну из списка" : !C.geo.length ? "Добавьте хотя бы одну страну" : "";
    fieldError("geo", geoErr); ok = ok && !geoErr;
    fieldError("offer", offerId ? "" : "Выберите оффер из списка"); ok = ok && !!offerId;
    var refsErr = ids.some(function (v) { return !v; }) ? "Выберите домен, группу и источник" : "";
    fieldError("refs", refsErr); ok = ok && !refsErr;
    if (!ok) { $f.find(".invalid").first().trigger("focus"); return; }

    C.submitting = true;
    var $btn = $f.find("[type=submit]").addClass("loading").prop("disabled", true);
    api("POST", "/api/campaigns", {
      name: name, geo: C.geo.slice(), offer_id: offerId, domain_id: ids[0], group_id: ids[1], traffic_source_id: ids[2],
    })
      .done(function (c) {
        toast("Кампания «" + c.name + "» создана в Keitaro");
        S.campaign = null;
        loadCampaigns();
        location.hash = "#/campaign/" + c.id;
      })
      .always(function () { C.submitting = false; $btn.removeClass("loading").prop("disabled", false); });
  });

  // =====================================================================
  // Часть 2. Кампания: аналитика + редактор потоков
  // =====================================================================
  function openCampaign(id) {
    S.campaign = null;
    S.stats = null;
    S.statsError = null;
    var info = S.campaigns.filter(function (c) { return c.id === id; })[0];
    $("#view").html(
      '<div class="view-inner"><div class="page-head"><div><div class="crumbs">Кампании / #' + id + "</div><h1>" +
      esc(info ? info.name : "Кампания #" + id) + '</h1></div></div><div class="card"><div class="card-body"><span class="skeleton">Загрузка кампании…</span></div></div></div>'
    );
    $.getJSON("/api/campaigns/" + id)
      .done(function (c) { if (parseHash().id !== id) return; S.campaign = c; renderCampaign(); loadStats(); })
      .fail(function (xhr) {
        if (parseHash().id !== id) return;
        if (xhr.status === 404) renderNotImported(id, info);
        else $("#view .card-body").html('<div class="banner banner-error">' + icon("alert") + "<span>" + esc(errText(xhr)) + "</span></div>");
      });
  }

  function renderNotImported(id, info) {
    $("#view").html(
      '<div class="view-inner">' +
        '<div class="page-head"><div><div class="crumbs">Кампании / #' + id + "</div><h1>" + esc(info ? info.name : "Кампания #" + id) + "</h1></div></div>" +
        '<div class="card empty-state">' +
          "<h2>Кампания ещё не загружена в приложение</h2>" +
          "<p>Загрузите потоки из Keitaro: потоки с офферами станут доступны для редактирования, остальные сохранятся как есть.</p>" +
          '<button class="btn btn-primary" data-act="fetch">' + icon("download") + "Загрузить потоки из Keitaro</button>" +
        "</div>" +
      "</div>"
    );
  }

  function loadStats() {
    var c = S.campaign;
    if (!c) return;
    S.statsLoading = true;
    S.statsError = null;
    renderAnalytics();
    renderStreams();
    $.ajax({ url: "/api/campaigns/" + c.id + "/stats", data: { period: S.period }, dataType: "json" })
      .done(function (data) { if (S.campaign && S.campaign.id === c.id && data.period === S.period) S.stats = data; })
      .fail(function (xhr) { S.stats = null; S.statsError = errText(xhr); })
      .always(function () {
        if (!S.campaign || S.campaign.id !== c.id) return;
        S.statsLoading = false;
        renderAnalytics();
        renderStreams();
      });
  }

  function renderCampaign() {
    var c = S.campaign;
    var link = keitaroCampaignLink(c.id);
    $("#view").html(
      '<div class="view-inner">' +
        '<div class="page-head">' +
          "<div>" +
            '<div class="crumbs">Кампании / #' + c.id + "</div>" +
            "<h1>" + esc(c.name) + "</h1>" +
            '<div class="meta-row">' +
              (c.url ? '<span class="url-chip"><code title="' + esc(c.url) + '">' + esc(c.url) + '</code><button class="icon-btn" data-copy="' + esc(c.url) + '" title="Скопировать ссылку" aria-label="Скопировать ссылку">' + icon("copy") + "</button></span>" : "") +
              (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">Открыть в Keitaro ' + "</a>" : "") +
              '<span class="sep"></span><span class="muted" id="synced"></span>' +
            "</div>" +
          "</div>" +
          '<div class="head-actions"><button class="btn" data-act="fetch" title="Fetch streams: заменить черновик состоянием Keitaro">' + icon("download") + "Загрузить из Keitaro</button></div>" +
        "</div>" +
        '<div id="banners"></div>' +
        '<section class="card" id="analytics"></section>' +
        '<h2 class="section-title">Потоки <span class="count">' + c.streams.length + "</span></h2>" +
        '<div id="streams" class="streams"></div>' +
        '<div id="dirty-bar" class="dirty-bar" role="status" hidden></div>' +
      "</div>"
    );
    renderHeadState();
    renderAnalytics();
    renderStreams();
  }

  function renderHeadState() {
    var c = S.campaign;
    $("#synced").text(c.synced_at ? "Синхронизировано " + new Date(c.synced_at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "");
    var dirty = dirtyStreams(c);
    // Плашка закреплена внизу, чтобы её появление не сдвигало кнопки под курсором.
    $("#dirty-bar").prop("hidden", !dirty.length).html(dirty.length
      ? icon("alert") + '<span class="dirty-text"><b>Не опубликовано в Keitaro:</b> ' +
        dirty.map(function (s) { return esc(s.name); }).join(", ") + ". Черновик сохранён и попадёт в трекер после публикации.</span>" +
        '<button class="btn btn-sm" data-act="goto-dirty" data-stream-id="' + dirty[0].id + '">К потоку</button>'
      : "");
    var html = "";
    if (!c.editable) {
      html += '<div class="banner banner-info">' + icon("lock") + "<span>Чужая кампания: только просмотр и статистика. Редактировать можно кампании с префиксом «" +
        esc(S.meta.campaign_prefix) + "» — правило тестового трекера, чтобы не сломать кампании других участников.</span></div>";
    }
    (c.warnings || []).forEach(function (w) { html += '<div class="banner banner-error">' + icon("alert") + "<span>" + esc(w) + "</span></div>"; });
    $("#banners").html(html).toggle(!!html);
  }

  // --- Аналитика ---
  function renderAnalytics() {
    var $a = $("#analytics");
    if (!$a.length) return;
    var seg = PERIODS.map(function (p) {
      return '<button type="button" data-period="' + p[0] + '" class="' + (p[0] === S.period ? "active" : "") + '">' + p[1] + "</button>";
    }).join("");
    var head = '<div class="card-head"><h2>Статистика кампании</h2><div class="segmented" role="group" aria-label="Период">' + seg + "</div></div>";

    if (S.statsError) {
      $a.html(head + '<div class="card-body"><div class="banner banner-error">' + icon("alert") +
        "<span>Статистика недоступна: " + esc(S.statsError) + '. Редактор потоков работает без неё.</span></div><div style="margin-top:10px"><button class="btn btn-sm" data-act="stats-retry">' + icon("refresh") + "Повторить</button></div></div>");
      return;
    }
    var t = S.stats ? S.stats.totals : null;
    var sk = function (v) { return S.statsLoading || !t ? '<span class="skeleton">00 000</span>' : v; };
    var tiles = [
      ["Клики", t && fBig(t.clicks), ""],
      ["Уникальные", t && fBig(t.unique), t && fPct(t.unique, t.clicks) + " от кликов"],
      ["Боты", t && fBig(t.bots), t && fPct(t.bots, t.clicks) + " от кликов"],
      ["Конверсии", t && fBig(t.conversions), ""],
      ["CR", t && fPct(t.conversions, t.clicks), "конверсии / клики"],
      ["Доход", t && fMoney(t.revenue), t && "EPC " + fMoney(t.clicks ? t.revenue / t.clicks : 0)],
    ];
    var kpis = '<div class="kpis">' + tiles.map(function (k) {
      return '<div class="kpi"><div class="kpi-label">' + k[0] + '</div><div class="kpi-value">' + sk(k[1]) + '</div><div class="kpi-sub">' + (S.statsLoading || !t ? "&nbsp;" : k[2] || "&nbsp;") + "</div></div>";
    }).join("") + "</div>";

    $a.html(head + kpis + '<div class="chart-wrap"><div class="chart-title"><span>Клики по дням</span><span class="muted small" id="chart-range"></span></div><div class="chart" id="chart"></div></div>');
    drawChart();
  }

  function niceMax(v) {
    if (v <= 0) return 4;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) { if (steps[i] * p * 4 >= v) return steps[i] * p * 4; }
    return 10 * p * 4;
  }

  function fmtDay(iso, withYear) {
    var p = iso.split("-");
    return p[2] + "." + p[1] + (withYear ? "." + p[0] : "");
  }

  function drawChart() {
    var $c = $("#chart");
    if (!$c.length) return;
    if (S.statsLoading || !S.stats) { $c.html('<div class="chart-note"><span class="skeleton">Загрузка статистики…</span></div>'); return; }
    var data = S.stats.daily || [];
    if (data.length) $("#chart-range").text(fmtDay(data[0].day, true) + (data.length > 1 ? " — " + fmtDay(data[data.length - 1].day, true) : ""));
    var max = data.reduce(function (m, d) { return Math.max(m, d.clicks); }, 0);
    if (data.length < 2) {
      $c.html('<div class="chart-note">За выбранный период один день' + (data.length ? ": " + fInt(data[0].clicks) + " " + plural(data[0].clicks, "клик", "клика", "кликов") : "") +
        ". Для графика по дням выберите период от 7 дней.</div>");
      return;
    }
    if (!max) { $c.html('<div class="chart-note">За выбранный период кликов нет.</div>'); return; }

    var W = Math.max($c.width(), 280), H = 200, ml = 44, mr = 6, mt = 8, mb = 24;
    var iw = W - ml - mr, ih = H - mt - mb;
    var top = niceMax(max);
    var band = iw / data.length;
    var bw = Math.max(2, Math.min(24, band - 2));
    var y = function (v) { return mt + ih - (v / top) * ih; };
    var svg = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Клики по дням">'];
    for (var i = 0; i <= 4; i++) {
      var v = (top / 4) * i, yy = Math.round(y(v)) + 0.5;
      svg.push('<line class="grid-line" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + yy + '" y2="' + yy + '"/>');
      svg.push('<text class="tick" x="' + (ml - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + (top >= 10000 ? nfCompact.format(v) : fInt(v)) + "</text>");
    }
    var every = Math.ceil(data.length / Math.max(1, Math.floor(iw / 52)));
    data.forEach(function (d, i) {
      var x = ml + band * i + (band - bw) / 2;
      var h = Math.max(0, (d.clicks / top) * ih), yt = mt + ih - h, r = Math.min(4, bw / 2, h);
      if (h > 0) {
        svg.push('<path class="bar" data-i="' + i + '" d="M' + x + "," + (mt + ih) + "V" + (yt + r) + "Q" + x + "," + yt + " " + (x + r) + "," + yt +
          "H" + (x + bw - r) + "Q" + (x + bw) + "," + yt + " " + (x + bw) + "," + (yt + r) + "V" + (mt + ih) + 'Z"/>');
      }
      if (i % every === 0) {
        svg.push('<text class="tick" x="' + (ml + band * i + band / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + fmtDay(d.day) + "</text>");
      }
      svg.push('<rect class="hit" data-i="' + i + '" x="' + (ml + band * i) + '" y="' + mt + '" width="' + band + '" height="' + ih + '"/>');
    });
    svg.push("</svg>");
    $c.html(svg.join("") + '<div class="tooltip" hidden></div>');

    var $tip = $c.find(".tooltip");
    $c.find(".hit").on("mouseenter", function () {
      var i = Number($(this).attr("data-i")), d = data[i];
      $c.find(".bar").addClass("dim").filter('[data-i="' + i + '"]').removeClass("dim");
      $tip.html("<b>" + fmtDay(d.day, true) + "</b>" +
        row("Клики", fInt(d.clicks)) + row("Уникальные", fInt(d.unique)) + row("Боты", fInt(d.bots)) +
        row("Конверсии", fInt(d.conversions)) + row("Доход", fMoney(d.revenue))).prop("hidden", false);
      var x = ml + band * i + band / 2, tw = $tip.outerWidth();
      var left = Math.min(Math.max(x - tw / 2, 0), W - tw);
      $tip.css({ left: left + "px", top: Math.max(0, y(d.clicks) - $tip.outerHeight() - 10) + "px" });
    });
    $c.find("svg").on("mouseleave", function () { $c.find(".bar").removeClass("dim"); $tip.prop("hidden", true); });
    function row(k, v) { return '<div class="row"><span>' + k + "</span><span>" + v + "</span></div>"; }
  }

  var resizeTimer;
  $(window).on("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 120); });

  // --- Потоки ---
  function statCells(m) {
    if (S.statsLoading) return repeat('<td class="r"><span class="skeleton">000</span></td>', 6);
    if (!m) return repeat('<td class="r muted">—</td>', 6);
    return '<td class="r num">' + fInt(m.clicks) + '</td><td class="r num">' + fInt(m.unique) + '</td><td class="r num">' + fInt(m.bots) +
      '</td><td class="r num">' + fInt(m.conversions) + '</td><td class="r num">' + fPct(m.conversions, m.clicks) + '</td><td class="r num">' + fMoney(m.revenue) + "</td>";
  }
  function repeat(s, n) { return new Array(n + 1).join(s); }

  function streamMetrics(sid) {
    var m = S.stats && S.stats.streams ? S.stats.streams[sid] : null;
    if (S.statsLoading) return '<div class="stream-metrics"><span class="skeleton">Клики 000 · Уникальные 000</span></div>';
    if (!m) return S.stats ? '<div class="stream-metrics"><span>Кликов за период нет</span></div>' : "";
    return '<div class="stream-metrics"><span>Клики<b class="num">' + fInt(m.clicks) + '</b></span><span>Уникальные<b class="num">' + fInt(m.unique) +
      '</b></span><span>Боты<b class="num">' + fInt(m.bots) + '</b></span><span>Конверсии<b class="num">' + fInt(m.conversions) +
      '</b></span><span>Доход<b class="num">' + fMoney(m.revenue) + "</b></span></div>";
  }

  var STATUS = {
    added: '<span class="tag tag-new">Будет добавлен</span>',
    removing: '<span class="tag tag-remove">Будет убран</span>',
    removed: '<span class="tag tag-archive">В архиве</span>',
  };

  function renderStreams() {
    var $s = $("#streams");
    if (!$s.length || !S.campaign) return;
    if (!S.campaign.streams.length) { $s.html('<div class="card empty-state"><h2>В кампании нет потоков</h2></div>'); return; }
    $s.html(S.campaign.streams.map(renderStream).join(""));
    if (!S.campaign.editable) $s.find(".stream-actions, .add-row, .row-actions button, .share-cell .icon-btn").remove();
    $s.find(".add-offer").each(function () {
      var $inp = $(this);
      offerAutocomplete($inp, function (offer) { $inp.data("offerId", offer.id); });
      $inp.on("input", function () { $inp.removeData("offerId"); });
    });
  }

  function renderStream(s) {
    var kind = s.has_offers ? "Офферы" : s.schema === "redirect" ? "Редирект" : "Без офферов";
    var head =
      '<div class="stream-head">' +
        '<div class="stream-title"><span class="pos" title="Позиция">' + s.position + "</span><b>" + esc(s.name) + "</b>" +
          '<span class="tag">' + kind + '</span><span class="tag">#' + s.id + "</span>" +
          (s.state && s.state !== "active" ? '<span class="tag tag-archive">' + esc(s.state) + "</span>" : "") +
          (s.is_dirty ? '<span class="tag tag-warn">Не опубликовано</span>' : "") +
        "</div>";

    if (!s.has_offers) {
      return '<article class="card stream" data-stream="' + s.id + '">' + head + "<div></div>" + streamMetrics(s.id) + "</div>" +
        '<div class="stream-empty">Поток без офферов: редактор хранит его как есть и не разбирает содержимое.</div></article>';
    }

    var live = s.offers.filter(function (o) { return o.status === "active" || o.status === "added"; });
    var bad = s.total_share !== 100;
    var why = !live.length ? "В потоке нет активных офферов." : bad ? "Сумма долей " + s.total_share + "%, а должна быть 100%. Снимите фиксацию с одной из долей или поправьте числа." : "";
    var dirtyCount = s.offers.filter(function (o) { return o.status === "added" || o.status === "removing" || (o.status === "active" && o.share !== o.published_share); }).length;

    head +=
        '<div class="stream-actions">' +
          '<button class="btn btn-sm" data-act="cancel"' + (s.is_dirty ? "" : " disabled") + ' title="Откатить к состоянию Keitaro">' + icon("undo") + "Отменить</button>" +
          '<button class="btn btn-sm btn-primary" data-act="push"' + (s.is_dirty && !why ? "" : " disabled") + ">" + icon("upload") + "Опубликовать" + (s.is_dirty && dirtyCount ? " (" + dirtyCount + ")" : "") + "</button>" +
        "</div>" +
        streamMetrics(s.id) +
      "</div>";

    var bar = '<div class="share-bar" aria-hidden="true">' + s.offers.map(function (o, i) {
      var isLive = o.status === "active" || o.status === "added";
      return isLive && o.share > 0 ? '<span style="width:' + o.share + "%;background:" + color(i) + '" title="' + esc(o.offer_name) + ": " + o.share + '%"></span>' : "";
    }).join("") + "</div>";

    var rows = s.offers.map(function (o, i) {
      var isLive = o.status === "active" || o.status === "added";
      var m = S.stats && S.stats.offers ? S.stats.offers[s.id + ":" + o.offer_id] : null;
      var showWas = (o.status === "active" && o.share !== o.published_share) || o.status === "removing";
      var share = isLive
        ? (o.pinned
          ? '<input class="share-input" type="number" min="0" max="100" step="1" value="' + o.share + '" aria-label="Зафиксированная доля, %">%'
          : '<span class="share-val">' + o.share + "%</span>")
        : '<span class="share-val muted">0%</span>';
      var lockBtn = isLive
        ? '<button class="icon-btn ' + (o.pinned ? "on" : "") + '" data-act="' + (o.pinned ? "unpin" : "pin") + '" title="' +
          (o.pinned ? "Снять фиксацию доли" : "Зафиксировать долю: она не изменится при добавлении и удалении офферов") +
          '" aria-label="' + (o.pinned ? "Снять фиксацию доли" : "Зафиксировать долю") + '" aria-pressed="' + o.pinned + '">' + icon(o.pinned ? "lock" : "unlock") + "</button>"
        : "";
      var action = isLive
        ? '<button class="btn btn-sm btn-danger-ghost" data-act="remove">Убрать</button>'
        : '<button class="btn btn-sm" data-act="restore">' + icon("undo") + "Вернуть</button>";
      return (
        '<tr class="' + (isLive ? "" : "archived") + '" data-link="' + o.id + '">' +
          '<td><div class="offer-cell"><span class="swatch" style="background:' + (isLive ? color(i) : "var(--line-strong)") + '"></span>' +
            '<span class="offer-id">' + o.offer_id + '</span><span class="offer-name">' + esc(offerName(o.offer_id, o.offer_name)) + "</span>" + (STATUS[o.status] || "") + "</div></td>" +
          '<td class="r"><div class="share-cell">' + share + lockBtn + "</div>" + (showWas ? '<span class="share-was">в Keitaro ' + o.published_share + "%</span>" : "") + "</td>" +
          statCells(m) +
          '<td class="row-actions">' + action + "</td>" +
        "</tr>"
      );
    }).join("");

    var sm = S.stats && S.stats.streams ? S.stats.streams[s.id] : null;
    var table =
      '<div class="table-wrap"><table class="grid">' +
        '<thead><tr><th>Оффер</th><th class="r">Доля</th><th class="r">Клики</th><th class="r">Уник.</th><th class="r">Боты</th><th class="r">Конв.</th><th class="r">CR</th><th class="r">Доход</th><th></th></tr></thead>' +
        "<tbody>" + rows + "</tbody>" +
        '<tfoot><tr><td>Итого по потоку</td><td class="r num' + (bad ? " total-bad" : "") + '">' + s.total_share + "%</td>" + statCells(sm) + "<td></td></tr></tfoot>" +
      "</table></div>";

    return (
      '<article class="card stream' + (s.is_dirty ? " dirty" : "") + '" data-stream="' + s.id + '">' + head + bar + table +
        (why && s.is_dirty ? '<div class="stream-hint" style="padding-top:10px">' + icon("alert") + esc(why) + "</div>" : "") +
        '<div class="add-row"><input class="input add-offer" placeholder="Добавить оффер: ID или название" aria-label="Добавить оффер">' +
        '<button class="btn" data-act="add">' + icon("plus") + "Добавить</button></div>" +
      "</article>"
    );
  }

  function color(i) { return i < 8 ? "var(--s" + (i + 1) + ")" : "var(--text-3)"; }

  // --- Действия редактора ---
  function setBusy(on) { S.busy = on; $("#view").toggleClass("busy", on); }

  function applyCampaign(c) {
    S.campaign = c;
    renderHeadState();
    $(".section-title .count").text(c.streams.length);
    renderStreams();
    var imported = S.campaigns.filter(function (x) { return x.id === c.id; })[0];
    if (imported && !imported.imported) { imported.imported = true; renderSidebar(); }
  }

  function run(req, $btn, okText) {
    setBusy(true);
    if ($btn) $btn.addClass("loading");
    return req
      .done(function (c) { applyCampaign(c); if (okText) toast(okText); })
      .fail(function () { if (S.campaign) renderStreams(); })
      .always(function () { setBusy(false); if ($btn) $btn.removeClass("loading"); });
  }

  function findStream(id) { return S.campaign.streams.filter(function (s) { return s.id === id; })[0]; }

  $("#view").on("click", "[data-copy]", function () { copyText($(this).attr("data-copy")); });
  $("#view").on("click", "[data-period]", function () {
    var p = $(this).data("period");
    if (p === S.period) return;
    S.period = p;
    store("period", p);
    loadStats();
  });
  $("#view").on("click", '[data-act="stats-retry"]', loadStats);
  $("#view").on("click", '[data-act="goto-dirty"]', function () {
    var el = document.querySelector('[data-stream="' + $(this).attr("data-stream-id") + '"]');
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#view").on("click", '[data-act="fetch"]', function () {
    if (S.busy) return;
    var id = parseHash().id;
    var $b = $(this);
    var dirty = dirtyStreams(S.campaign);
    var go = function () {
      setBusy(true);
      $b.addClass("loading");
      api("POST", "/api/campaigns/" + id + "/fetch")
        .done(function (c) {
          var first = !S.campaign;
          S.campaign = c;
          if (first) renderCampaign(); else applyCampaign(c);
          loadStats();
          toast("Потоки загружены из Keitaro");
          loadCampaigns();
        })
        .always(function () { setBusy(false); $b.removeClass("loading"); });
    };
    if (!dirty.length) { go(); return; }
    dialog({
      title: "Заменить черновик данными Keitaro?",
      text: "Неопубликованные изменения в " + dirty.length + " " + plural(dirty.length, "потоке", "потоках", "потоках") +
        " будут потеряны: черновик заменится тем, что сейчас лежит в Keitaro.",
      ok: "Загрузить и заменить", danger: true,
    }).then(function (ok) { if (ok) go(); });
  });

  $("#view").on("click", ".stream [data-act]", function () {
    if (S.busy) return;
    var $b = $(this);
    var act = $b.data("act");
    var streamId = $b.closest("[data-stream]").data("stream");
    var linkId = $b.closest("[data-link]").data("link");

    if (act === "add") {
      var $inp = $b.closest(".add-row").find(".add-offer");
      var typed = $.trim($inp.val());
      var offerId = $inp.data("offerId") || (/^\d+$/.test(typed) ? Number(typed) : null);
      if (!offerId) { toast("Выберите оффер из списка или введите его ID", "error"); $inp.trigger("focus"); return; }
      run(api("POST", "/api/streams/" + streamId + "/offers", { offer_id: offerId }), $b);
    } else if (act === "remove") {
      run(api("POST", "/api/stream-offers/" + linkId + "/remove"), $b);
    } else if (act === "restore") {
      run(api("POST", "/api/stream-offers/" + linkId + "/restore"), $b);
    } else if (act === "pin") {
      run(api("POST", "/api/stream-offers/" + linkId + "/pin", {}), $b);
    } else if (act === "unpin") {
      run(api("POST", "/api/stream-offers/" + linkId + "/unpin"), $b);
    } else if (act === "cancel") {
      run(api("POST", "/api/streams/" + streamId + "/cancel"), $b, "Изменения потока отменены");
    } else if (act === "push") {
      var s = findStream(streamId);
      var live = s.offers.filter(function (o) { return o.status === "active" || o.status === "added"; });
      var gone = s.offers.filter(function (o) { return o.status === "removing"; });
      dialog({
        title: "Опубликовать «" + s.name + "» в Keitaro?",
        text: "В потоке останется " + live.length + " " + plural(live.length, "оффер", "оффера", "офферов") + ":\n" +
          live.map(function (o) { return "• [" + o.offer_id + "] " + offerName(o.offer_id, o.offer_name) + " — " + o.share + "%"; }).join("\n") +
          (gone.length ? "\n\nБудут убраны:\n" + gone.map(function (o) { return "• [" + o.offer_id + "] " + offerName(o.offer_id, o.offer_name); }).join("\n") : ""),
        ok: "Опубликовать",
      }).then(function (ok) {
        if (ok) run(api("POST", "/api/streams/" + streamId + "/push"), $b, "Поток опубликован в Keitaro").done(loadStats);
      });
    }
  });

  // Изменение зафиксированной доли: Enter или уход с поля
  $("#view").on("change", ".share-input", function () {
    if (S.busy) return;
    var linkId = $(this).closest("[data-link]").data("link");
    var v = Number($(this).val());
    if (!(v >= 0 && v <= 100) || $(this).val() === "") { toast("Доля должна быть от 0 до 100", "error"); renderStreams(); return; }
    run(api("POST", "/api/stream-offers/" + linkId + "/pin", { share: Math.round(v) }));
  });
  $("#view").on("keydown", ".share-input", function (e) { if (e.key === "Enter") { e.preventDefault(); $(this).trigger("blur"); } });
  $("#view").on("keydown", ".add-offer", function (e) {
    if (e.key === "Enter" && !$(this).autocomplete("widget").is(":visible")) {
      $(this).closest(".add-row").find('[data-act="add"]').trigger("click");
    }
  });

  // =====================================================================
  // Старт
  // =====================================================================
  $("#nav-new").html(icon("plus") + "Новая кампания");
  $("#reload-campaigns").html(icon("refresh"));
  $(".search-icon").html(icon("search"));

  $.getJSON("/api/meta").always(function (m) {
    if (m && m.geo_redirect_url) S.meta = m;
    setConn();
    $("#view").html('<div class="view-inner"><div class="card"><div class="card-body loading-note"><span class="spinner"></span>Подключение к Keitaro' +
      (S.meta.fake_keitaro ? " (эмулятор)" : "") + "…</div></div></div>");
    $("#campaign-list").html('<li class="list-empty">Загрузка кампаний…</li>');
    // Справочники и список кампаний грузим параллельно; страницу рисуем, когда есть оба.
    $.when(loadRefs(), loadCampaigns()).always(function () {
      if (!location.hash) history.replaceState(null, "", "#/new");
      lastHash = location.hash;
      route();
    });
  });
})();
