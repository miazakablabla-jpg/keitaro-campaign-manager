/* global $ */
(function () {
  "use strict";

  var META = { fake_keitaro: true, keitaro_admin_url: null, geo_redirect_url: "https://google.com" };

  // ---------- helpers ----------
  function api(method, url, body) {
    return $.ajax({
      method: method,
      url: url,
      contentType: "application/json",
      data: body === undefined ? undefined : JSON.stringify(body),
      dataType: "json",
    }).fail(function (xhr) {
      var msg = (xhr.responseJSON && xhr.responseJSON.detail) || xhr.statusText || "Ошибка";
      if (typeof msg !== "string") msg = JSON.stringify(msg);
      if (xhr.status === 0) msg = "Сервер обёртки недоступен";
      toast(msg, "error");
    });
  }

  function toast(text, kind) {
    var $t = $("#toast");
    $t.removeClass("error ok").addClass(kind || "ok").text(text).prop("hidden", false);
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { $t.prop("hidden", true); }, kind === "error" ? 7000 : 3000);
  }

  function esc(s) {
    return $("<div>").text(s == null ? "" : String(s)).html();
  }

  function offerLabel(o) { return "[" + o.id + "] " + o.name; }

  function keitaroCampaignLink(id) {
    return META.keitaro_admin_url ? META.keitaro_admin_url + "#!/campaigns/" + id : null;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Скопировано"); }, function () { toast(text); });
    } else {
      toast(text);
    }
  }
  $(document).on("click", "[data-copy]", function () { copyText($(this).data("copy")); });

  // Автокомплит офферов: jQuery UI → /api/offers/search → Keitaro GET /offers
  function offerAutocomplete($input, onSelect) {
    $input.autocomplete({
      minLength: 0,
      delay: 200,
      source: function (req, res) {
        $.getJSON("/api/offers/search", { q: req.term })
          .done(function (rows) {
            if (!rows.length) { res([{ label: "Ничего не найдено", value: "", disabled: true }]); return; }
            res(rows.map(function (o) { return { label: offerLabel(o), value: offerLabel(o), offer: o }; }));
          })
          .fail(function () { res([]); });
      },
      select: function (e, ui) {
        if (!ui.item.offer) { e.preventDefault(); return; }
        onSelect(ui.item.offer);
      },
    }).on("focus", function () { $(this).autocomplete("search", $(this).val()); });
  }

  // ---------- tabs ----------
  function showTab(tab) {
    $(".tab").removeClass("active").filter('[data-tab="' + tab + '"]').addClass("active");
    $(".panel").prop("hidden", true);
    $("#tab-" + tab).prop("hidden", false);
  }
  $(".tab").on("click", function () {
    var tab = $(this).data("tab");
    showTab(tab);
    if (tab === "editor") loadCampaignList();
  });

  // ---------- part 1: creator ----------
  var $form = $("#create-form");

  function fillSelect($sel, rows) {
    var keep = $sel.val();
    $sel.empty();
    if (!rows.length) $sel.append($("<option>").val("").text("— пусто —"));
    rows.forEach(function (r) { $sel.append($("<option>").val(r.id).text(r.name)); });
    if (keep && $sel.find('option[value="' + keep + '"]').length) $sel.val(keep);
  }

  function loadRefs() {
    return api("GET", "/api/refs").done(function (refs) {
      fillSelect($form.find("[name=domain_id]"), refs.domains);
      fillSelect($form.find("[name=group_id]"), refs.groups);
      fillSelect($form.find("[name=traffic_source_id]"), refs.sources);
    });
  }

  // --- Geo: чипсы стран ---
  var geo = [];
  var $chips = $("#geo-chips");
  var $geoInput = $("#geo-input");

  function renderGeo() {
    $chips.find(".chip").remove();
    geo.forEach(function (code) {
      var c = window.COUNTRY_BY_CODE[code];
      $('<span class="chip">')
        .attr("title", c ? c.name : code)
        .append($("<b>").text(code))
        .append(c && c.name !== code ? $("<span>").text(" " + c.name) : "")
        .append($('<button type="button" class="chip-x" aria-label="Убрать">×</button>').attr("data-code", code))
        .insertBefore($geoInput);
    });
    $chips.toggleClass("has-chips", geo.length > 0);
  }

  function addGeo(code) {
    code = String(code || "").trim().toUpperCase();
    if (!window.COUNTRY_BY_CODE[code]) return false;
    if (geo.indexOf(code) === -1) geo.push(code);
    renderGeo();
    return true;
  }

  // «mx, au;RO» или «Мексика» → чипсы; нераспознанное возвращаем в поле
  function consumeGeoText(text) {
    var rest = [];
    // Сначала делим по запятым («Южная Корея» — одна страна), потом пробуем по пробелам («MX AU RO»).
    var parts = [];
    text.split(/[,;\n]+/).forEach(function (chunk) {
      chunk = chunk.trim();
      if (!chunk) return;
      var byName = window.COUNTRIES.some(function (c) { return c.name.toLowerCase() === chunk.toLowerCase(); });
      if (byName || window.COUNTRY_BY_CODE[chunk.toUpperCase()]) parts.push(chunk);
      else parts = parts.concat(chunk.split(/\s+/));
    });
    parts.forEach(function (part) {
      if (!part) return;
      if (addGeo(part)) return;
      var byName = window.COUNTRIES.filter(function (c) { return c.name.toLowerCase() === part.toLowerCase(); })[0];
      if (byName) addGeo(byName.code); else rest.push(part);
    });
    return rest.join(" ");
  }

  $geoInput.autocomplete({
    minLength: 1,
    delay: 0,
    autoFocus: true,
    source: function (req, res) {
      var q = req.term.trim().toLowerCase();
      var rows = window.COUNTRIES.filter(function (c) {
        return geo.indexOf(c.code) === -1 && (c.code.toLowerCase() === q || c.name.toLowerCase().indexOf(q) !== -1);
      });
      rows.sort(function (a, b) {
        var aw = a.code.toLowerCase() === q ? 0 : a.name.toLowerCase().indexOf(q) === 0 ? 1 : 2;
        var bw = b.code.toLowerCase() === q ? 0 : b.name.toLowerCase().indexOf(q) === 0 ? 1 : 2;
        return aw - bw;
      });
      res(rows.slice(0, 12).map(function (c) { return { label: c.code + " — " + c.name, value: "", code: c.code }; }));
    },
    select: function (e, ui) {
      e.preventDefault();
      addGeo(ui.item.code);
      $geoInput.val("");
    },
  });
  $geoInput.on("keydown", function (e) {
    if (e.key === "Backspace" && !this.value && geo.length) { geo.pop(); renderGeo(); }
    var sep = e.key === "," || e.key === ";";
    var enter = e.key === "Enter" && !$geoInput.autocomplete("widget").is(":visible");
    if (sep || enter) {
      e.preventDefault();
      if (this.value.trim()) this.value = consumeGeoText(this.value);
      $geoInput.autocomplete("close");
    }
  });
  $geoInput.on("paste", function () {
    var el = this;
    setTimeout(function () { el.value = consumeGeoText(el.value); $geoInput.autocomplete("close"); }, 0);
  });
  $geoInput.on("blur", function () { if (this.value.trim()) this.value = consumeGeoText(this.value); });
  $chips.on("click", ".chip-x", function () {
    var code = $(this).data("code");
    geo = geo.filter(function (c) { return c !== code; });
    renderGeo();
  });
  $chips.on("click", function (e) { if (e.target === this) $geoInput.trigger("focus"); });

  // --- Offer ---
  var createOffer = null;
  offerAutocomplete($("#create-offer"), function (offer) {
    createOffer = offer;
    $form.find("[name=offer_id]").val(offer.id);
  });
  $("#create-offer").on("input", function () { createOffer = null; $form.find("[name=offer_id]").val(""); });

  $form.on("click", "[data-create]", function () {
    var kind = $(this).data("create");
    var name = window.prompt(kind === "groups" ? "Название новой группы" : "Название нового источника");
    if (!name || !name.trim()) return;
    api("POST", "/api/refs/" + kind, { name: name.trim() }).done(function (row) {
      var field = kind === "groups" ? "group_id" : "traffic_source_id";
      var $sel = $form.find("[name=" + field + "]");
      $sel.find('option[value=""]').remove();
      $sel.append($("<option>").val(row.id).text(row.name)).val(String(row.id));
      toast("Создано в Keitaro: " + row.name);
    });
  });

  $form.on("submit", function (e) {
    e.preventDefault();
    var pending = $.trim($geoInput.val());
    if (pending) $geoInput.val(consumeGeoText(pending));

    var name = $.trim($form.find("[name=name]").val());
    var offerId = $form.find("[name=offer_id]").val();
    var typed = $.trim($("#create-offer").val());
    if (!offerId && /^\d+$/.test(typed)) offerId = typed; // можно просто вписать ID

    if (!name) { toast("Укажите название кампании", "error"); $form.find("[name=name]").trigger("focus"); return; }
    if ($.trim($geoInput.val())) { toast("Не распознана страна: «" + $geoInput.val() + "»", "error"); $geoInput.trigger("focus"); return; }
    if (!geo.length) { toast("Добавьте хотя бы одну страну", "error"); $geoInput.trigger("focus"); return; }
    if (!offerId) { toast("Выберите оффер из списка", "error"); $("#create-offer").trigger("focus"); return; }
    var ids = ["domain_id", "group_id", "traffic_source_id"].map(function (f) { return Number($form.find("[name=" + f + "]").val()); });
    if (ids.some(function (v) { return !v; })) { toast("Выберите домен, группу и источник", "error"); return; }

    var body = { name: name, geo: geo.slice(), offer_id: Number(offerId), domain_id: ids[0], group_id: ids[1], traffic_source_id: ids[2] };
    var offerName = createOffer ? offerLabel(createOffer) : "[" + offerId + "]";
    var $btn = $form.find("[type=submit]").prop("disabled", true).text("Создаю…");
    api("POST", "/api/campaigns", body)
      .done(function (c) {
        toast("Кампания «" + c.name + "» создана");
        renderCreated(c, body, offerName);
        $form[0].reset();
        $form.find("[name=offer_id]").val("");
        createOffer = null;
        geo = [];
        renderGeo();
      })
      .always(function () { $btn.prop("disabled", false).text("Create"); });
  });

  function renderCreated(c, body, offerName) {
    var link = keitaroCampaignLink(c.id);
    $("#create-result").html(
      '<div class="card result">' +
        '<div class="result-head"><span class="ok-mark">✓</span><b>' + esc(c.name) + '</b><span class="muted">ID ' + c.id + "</span></div>" +
        (c.url
          ? '<div class="url-row"><code>' + esc(c.url) + '</code><button class="btn small ghost" data-copy="' + esc(c.url) + '">Копировать</button></div>'
          : "") +
        '<ol class="flows">' +
          "<li><b>Flow 1</b> — страны <b>" + esc(body.geo.join(", ")) + "</b> → " + esc(META.geo_redirect_url) + "</li>" +
          "<li><b>Flow 2</b> — все остальные → " + esc(offerName) + " · 100%</li>" +
        "</ol>" +
        '<div class="result-actions">' +
          '<button class="btn primary" data-open="' + c.id + '">Открыть в редакторе</button>' +
          (link ? '<a class="btn ghost" target="_blank" rel="noopener" href="' + esc(link) + '">Открыть в Keitaro ↗</a>' : "") +
        "</div>" +
      "</div>"
    );
  }

  $("#create-result").on("click", "[data-open]", function () {
    var id = $(this).data("open");
    showTab("editor");
    loadCampaignList(id).done(function () { openCampaign(id); });
  });

  // ---------- part 2: editor ----------
  var current = null; // CampaignOut
  var busy = false;

  function dirtyCount(c) {
    return c ? c.streams.filter(function (s) { return s.is_dirty; }).length : 0;
  }

  function setBusy(on) {
    busy = on;
    $("#campaign").toggleClass("busy", on);
    $("#campaign-select").prop("disabled", on);
    $("#fetch-btn").prop("disabled", on || !$("#campaign-select").val());
  }

  function loadCampaignList(selectId) {
    var $sel = $("#campaign-select");
    var keep = selectId || $sel.val();
    return api("GET", "/api/keitaro/campaigns").done(function (rows) {
      $sel.find("option:not(:first)").remove();
      rows.forEach(function (c) {
        $sel.append($("<option>").val(c.id).text("[" + c.id + "] " + c.name + (c.imported ? "" : "  — не загружена")));
      });
      if (keep) $sel.val(String(keep));
      $("#fetch-btn").prop("disabled", !$sel.val());
    });
  }

  function openCampaign(id) {
    $("#campaign-select").val(String(id)).data("prev", String(id));
    $("#fetch-btn").prop("disabled", false);
    $.getJSON("/api/campaigns/" + id)
      .done(render)
      .fail(function () {
        current = null;
        $("#campaign").html(
          '<div class="card empty">Кампания ещё не загружена в обёртку.<br>Нажмите <b>Fetch streams</b>, чтобы забрать её потоки из Keitaro.</div>'
        );
      });
  }

  $("#campaign-select").on("change", function () {
    var $sel = $(this);
    var id = $sel.val();
    var n = dirtyCount(current);
    if (n && !window.confirm(
      "В «" + current.name + "» есть неопубликованные правки (" + n + " " + plural(n, "поток", "потока", "потоков") + ").\n" +
      "Они останутся черновиком в обёртке, но в Keitaro не попадут, пока вы не нажмёте Push. Перейти к другой кампании?"
    )) {
      $sel.val($sel.data("prev") || "");
      return;
    }
    if (id) openCampaign(id);
    else { current = null; $sel.data("prev", ""); $("#campaign").empty(); $("#fetch-btn").prop("disabled", true); }
  });
  $("#reload-campaigns").on("click", function () { loadCampaignList().done(function () { toast("Список кампаний обновлён"); }); });

  $("#fetch-btn").on("click", function () {
    var id = $("#campaign-select").val();
    if (!id || busy) return;
    if (current && String(current.id) === String(id) && dirtyCount(current) &&
        !window.confirm("Fetch заменит неопубликованные правки тем, что сейчас лежит в Keitaro. Продолжить?")) {
      return;
    }
    var $b = $(this).text("Загружаю…");
    setBusy(true);
    api("POST", "/api/campaigns/" + id + "/fetch")
      .done(function (c) { render(c); toast("Потоки загружены из Keitaro"); loadCampaignList(); })
      .always(function () { $b.text("Fetch streams"); setBusy(false); });
  });

  window.addEventListener("beforeunload", function (e) {
    if (dirtyCount(current)) { e.preventDefault(); e.returnValue = ""; }
  });

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  var STATUS = {
    active: { text: "", cls: "" },
    added: { text: "добавлен", cls: "badge-add" },
    removing: { text: "будет удалён", cls: "badge-del" },
    removed: { text: "removed", cls: "badge-gone" },
  };

  function render(c) {
    current = c;
    var n = dirtyCount(c);
    var link = keitaroCampaignLink(c.id);
    var html =
      '<div class="camp-head">' +
        '<div class="camp-title"><h2>' + esc(c.name) + ' <span class="muted">#' + c.id + "</span></h2>" +
          (link ? '<a class="small" target="_blank" rel="noopener" href="' + esc(link) + '">Открыть в Keitaro ↗</a>' : "") +
        "</div>" +
        (c.url ? '<div class="url-row"><code>' + esc(c.url) + '</code><button class="btn small ghost" data-copy="' + esc(c.url) + '">Копировать</button></div>' : "") +
        (c.synced_at ? '<div class="muted small">Последний Fetch: ' + new Date(c.synced_at).toLocaleString() + "</div>" : "") +
      "</div>";
    if (n) {
      html += '<div class="unpublished">Не опубликовано в Keitaro: ' + n + " " + plural(n, "поток", "потока", "потоков") +
        ". Черновик сохранён в обёртке — нажмите <b>Push to Keitaro</b> в нужном потоке.</div>";
    }
    (c.warnings || []).forEach(function (w) { html += '<div class="warn">' + esc(w) + "</div>"; });
    c.streams.forEach(function (s) { html += renderStream(s); });
    if (!c.streams.length) html += '<div class="card empty">В кампании нет потоков.</div>';
    $("#campaign").html(html);
    $("#campaign .add-offer").each(function () {
      var $inp = $(this);
      offerAutocomplete($inp, function (offer) { $inp.data("offerId", offer.id); });
      $inp.on("input", function () { $inp.removeData("offerId"); });
    });
  }

  function renderStream(s) {
    var cls = "card stream" + (s.is_dirty ? " dirty" : "");
    var head =
      '<div class="stream-head">' +
        '<span class="dot ' + (s.state === "active" ? "on" : "") + '"></span>' +
        "<b>" + esc(s.name) + "</b>" +
        '<span class="muted small">#' + s.id + " · позиция " + s.position + "</span>" +
        (s.is_dirty ? '<span class="badge-dirty">не опубликовано</span>' : "") +
      "</div>";

    if (!s.has_offers) {
      return '<div class="' + cls + '">' + head + '<div class="muted small">Поток без офферов — содержимое не разбираем.</div></div>';
    }

    var activeCount = s.offers.filter(function (o) { return o.status === "active" || o.status === "added"; }).length;
    var rows = s.offers.map(function (o) {
      var st = STATUS[o.status];
      var live = o.status === "active" || o.status === "added";
      var changed = live && o.share !== o.published_share && o.status === "active";
      return (
        '<tr class="' + (live ? "" : "gone") + '" data-link="' + o.id + '">' +
          '<td class="name">[' + o.offer_id + "] " + esc(o.offer_name) +
            (st.text ? ' <span class="' + st.cls + '">' + st.text + "</span>" : "") + "</td>" +
          '<td class="share">' +
            (live
              ? '<input type="number" min="0" max="100" class="share-input" value="' + o.share + '"' +
                (o.pinned ? ' title="Закреплённый вес: поменяйте число и нажмите Enter"' : " readonly tabindex=\"-1\"") + ">%"
              : '<span class="zero">0%</span>') +
            (changed ? '<span class="was" title="сейчас в Keitaro">было ' + o.published_share + "%</span>" : "") +
          "</td>" +
          '<td class="pin">' +
            (live
              ? '<button class="icon ' + (o.pinned ? "pinned" : "") + '" data-act="' + (o.pinned ? "unpin" : "pin") + '" title="' +
                (o.pinned ? "Открепить вес" : "Закрепить вес") + '" aria-label="' + (o.pinned ? "Открепить вес" : "Закрепить вес") + '">📌</button>'
              : "") +
          "</td>" +
          '<td class="act">' +
            (live
              ? '<button class="btn small danger" data-act="remove"' + (activeCount === 1 ? ' title="Последний активный оффер: без него Push будет недоступен"' : "") + ">Remove</button>"
              : '<button class="btn small" data-act="restore">Bring back</button>') +
          "</td>" +
        "</tr>"
      );
    }).join("");

    var bad = s.total_share !== 100;
    var why = !activeCount ? "В потоке нет активных офферов" : bad ? "Сумма весов должна быть 100%" : "";
    return (
      '<div class="' + cls + '" data-stream="' + s.id + '">' + head +
        '<table class="offers"><tbody>' + rows + "</tbody></table>" +
        '<div class="stream-foot">' +
          '<span class="add-wrap"><input class="add-offer" placeholder="Добавить оффер: ID или название"><button class="btn small" data-act="add">Add</button></span>' +
          '<span class="total ' + (bad ? "bad" : "") + '" title="Сумма весов активных офферов">Σ ' + s.total_share + "%</span>" +
          '<button class="btn small ghost" data-act="cancel"' + (s.is_dirty ? "" : " disabled") + ">Cancel</button>" +
          '<button class="btn small primary" data-act="push"' + (s.is_dirty && !why ? "" : " disabled") +
            (why && s.is_dirty ? ' title="' + why + '"' : "") + ">Push to Keitaro</button>" +
        "</div>" +
        (why && s.is_dirty ? '<div class="foot-hint">' + why + ". Открепите один из весов или поправьте числа.</div>" : "") +
      "</div>"
    );
  }

  // Все действия редактора идут по одному: пока запрос в пути, кнопки заблокированы.
  function run(req, okText) {
    setBusy(true);
    return req
      .done(function (c) { render(c); if (okText) toast(okText); })
      .fail(function () { if (current) render(current); })
      .always(function () { setBusy(false); });
  }

  $("#campaign").on("click", "[data-act]", function () {
    if (busy) return;
    var act = $(this).data("act");
    var $stream = $(this).closest("[data-stream]");
    var streamId = $stream.data("stream");
    var linkId = $(this).closest("[data-link]").data("link");

    switch (act) {
      case "add": {
        var $inp = $stream.find(".add-offer");
        var offerId = $inp.data("offerId");
        var typed = $.trim($inp.val());
        if (!offerId && /^\d+$/.test(typed)) offerId = Number(typed);
        if (!offerId) { toast("Выберите оффер из списка", "error"); $inp.trigger("focus"); return; }
        run(api("POST", "/api/streams/" + streamId + "/offers", { offer_id: offerId }));
        return;
      }
      case "remove": run(api("POST", "/api/stream-offers/" + linkId + "/remove")); return;
      case "restore": run(api("POST", "/api/stream-offers/" + linkId + "/restore")); return;
      case "pin": {
        var share = Number($(this).closest("tr").find(".share-input").val());
        run(api("POST", "/api/stream-offers/" + linkId + "/pin", { share: share }));
        return;
      }
      case "unpin": run(api("POST", "/api/stream-offers/" + linkId + "/unpin")); return;
      case "cancel": run(api("POST", "/api/streams/" + streamId + "/cancel"), "Правки потока отменены"); return;
      case "push":
        $(this).text("Публикую…");
        run(api("POST", "/api/streams/" + streamId + "/push"), "Опубликовано в Keitaro");
        return;
    }
  });

  // Изменение закреплённого веса: Enter или уход с поля
  $("#campaign").on("change", ".share-input:not([readonly])", function () {
    if (busy) return;
    var linkId = $(this).closest("[data-link]").data("link");
    var share = Number($(this).val());
    if (!(share >= 0 && share <= 100)) { toast("Вес должен быть от 0 до 100", "error"); render(current); return; }
    run(api("POST", "/api/stream-offers/" + linkId + "/pin", { share: Math.round(share) }));
  });
  $("#campaign").on("keydown", ".share-input:not([readonly])", function (e) {
    if (e.key === "Enter") $(this).trigger("change");
  });
  $("#campaign").on("keydown", ".add-offer", function (e) {
    if (e.key === "Enter" && !$(this).autocomplete("widget").is(":visible")) {
      $(this).closest(".stream-foot").find('[data-act="add"]').trigger("click");
    }
  });

  // ---------- init ----------
  $.getJSON("/api/meta").done(function (m) {
    META = m;
    $(".geo-target").text(m.geo_redirect_url.replace(/^https?:\/\//, ""));
    if (m.fake_keitaro) $("#conn").text("эмулятор Keitaro").prop("hidden", false);
  });
  loadRefs();
})();
