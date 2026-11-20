/* global $ */
(function () {
  "use strict";

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

  // Автокомплит офферов: jQuery UI → /api/offers/search → Keitaro GET /offers
  function offerAutocomplete($input, onSelect) {
    $input.autocomplete({
      minLength: 0,
      delay: 200,
      source: function (req, res) {
        $.getJSON("/api/offers/search", { q: req.term })
          .done(function (rows) {
            res(rows.map(function (o) { return { label: offerLabel(o), value: offerLabel(o), offer: o }; }));
          })
          .fail(function () { res([]); });
      },
      select: function (_e, ui) { onSelect(ui.item.offer); },
    }).on("focus", function () { $(this).autocomplete("search", $(this).val()); });
  }

  // ---------- tabs ----------
  $(".tab").on("click", function () {
    var tab = $(this).data("tab");
    $(".tab").removeClass("active");
    $(this).addClass("active");
    $(".panel").prop("hidden", true);
    $("#tab-" + tab).prop("hidden", false);
    if (tab === "editor") loadCampaignList();
  });

  // ---------- part 1: creator ----------
  var $form = $("#create-form");

  function fillSelect($sel, rows, selectedId) {
    $sel.empty();
    rows.forEach(function (r) { $sel.append($("<option>").val(r.id).text(r.name)); });
    if (selectedId) $sel.val(String(selectedId));
  }

  function loadRefs() {
    return api("GET", "/api/refs").done(function (refs) {
      fillSelect($form.find("[name=domain_id]"), refs.domains);
      fillSelect($form.find("[name=group_id]"), refs.groups);
      fillSelect($form.find("[name=traffic_source_id]"), refs.sources);
    });
  }

  offerAutocomplete($("#create-offer"), function (offer) {
    $form.find("[name=offer_id]").val(offer.id);
  });
  $("#create-offer").on("input", function () { $form.find("[name=offer_id]").val(""); });

  $form.on("click", "[data-create]", function () {
    var kind = $(this).data("create");
    var name = window.prompt(kind === "groups" ? "Название новой группы" : "Название нового источника");
    if (!name) return;
    api("POST", "/api/refs/" + kind, { name: name }).done(function (row) {
      var field = kind === "groups" ? "group_id" : "traffic_source_id";
      var $sel = $form.find("[name=" + field + "]");
      $sel.append($("<option>").val(row.id).text(row.name)).val(String(row.id));
      toast("Создано: " + row.name);
    });
  });

  $form.on("submit", function (e) {
    e.preventDefault();
    var offerId = $form.find("[name=offer_id]").val();
    var typed = $.trim($("#create-offer").val());
    if (!offerId && /^\d+$/.test(typed)) offerId = typed; // можно просто вписать ID
    if (!offerId) { toast("Выберите оффер из списка", "error"); return; }

    var body = {
      name: $form.find("[name=name]").val(),
      geo: $form.find("[name=geo]").val(),
      offer_id: Number(offerId),
      domain_id: Number($form.find("[name=domain_id]").val()),
      group_id: Number($form.find("[name=group_id]").val()),
      traffic_source_id: Number($form.find("[name=traffic_source_id]").val()),
    };
    var $btn = $form.find("[type=submit]").prop("disabled", true).text("Создаю…");
    api("POST", "/api/campaigns", body)
      .done(function (c) {
        toast("Кампания «" + c.name + "» создана");
        $("#create-result").html(
          '<div class="card result">' +
            "<div><b>" + esc(c.name) + "</b> · ID " + c.id + "</div>" +
            (c.url ? '<div class="url"><code>' + esc(c.url) + "</code></div>" : "") +
            '<button class="btn" data-open="' + c.id + '">Открыть в редакторе</button>' +
          "</div>"
        );
        $form[0].reset();
        $form.find("[name=offer_id]").val("");
        loadRefs();
      })
      .always(function () { $btn.prop("disabled", false).text("Create"); });
  });

  $("#create-result").on("click", "[data-open]", function () {
    var id = $(this).data("open");
    $('.tab[data-tab="editor"]').trigger("click");
    loadCampaignList(id).done(function () { openCampaign(id); });
  });

  // ---------- part 2: editor ----------
  var current = null; // CampaignOut

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
    $("#campaign-select").val(String(id));
    $("#fetch-btn").prop("disabled", false);
    $.getJSON("/api/campaigns/" + id)
      .done(render)
      .fail(function () {
        current = null;
        $("#campaign").html('<p class="muted">Кампания ещё не загружена в обёртку. Нажмите <b>Fetch streams</b>.</p>');
      });
  }

  $("#campaign-select").on("change", function () {
    var id = $(this).val();
    if (id) openCampaign(id); else { $("#campaign").empty(); $("#fetch-btn").prop("disabled", true); }
  });
  $("#reload-campaigns").on("click", function () { loadCampaignList(); });

  $("#fetch-btn").on("click", function () {
    var id = $("#campaign-select").val();
    if (!id) return;
    var $b = $(this).prop("disabled", true).text("Загружаю…");
    api("POST", "/api/campaigns/" + id + "/fetch")
      .done(function (c) { render(c); toast("Потоки загружены из Keitaro"); loadCampaignList(); })
      .always(function () { $b.prop("disabled", false).text("Fetch streams"); });
  });

  var STATUS = {
    active: { text: "", cls: "" },
    added: { text: "добавлен", cls: "badge-add" },
    removing: { text: "будет удалён", cls: "badge-del" },
    removed: { text: "removed", cls: "badge-gone" },
  };

  function render(c) {
    current = c;
    var html =
      '<div class="camp-head">' +
        "<h2>" + esc(c.name) + ' <span class="muted">#' + c.id + "</span></h2>" +
        (c.url ? "<code>" + esc(c.url) + "</code>" : "") +
        (c.synced_at ? '<div class="muted small">Fetch: ' + new Date(c.synced_at).toLocaleString() + "</div>" : "") +
      "</div>";
    (c.warnings || []).forEach(function (w) { html += '<div class="warn">' + esc(w) + "</div>"; });
    c.streams.forEach(function (s) { html += renderStream(s); });
    if (!c.streams.length) html += '<p class="muted">В кампании нет потоков.</p>';
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
              ? '<input type="number" min="0" max="100" class="share-input" value="' + o.share + '"' + (o.pinned ? "" : " readonly") + ">%"
              : '<span class="zero">0%</span>') +
            (changed ? '<span class="was" title="сейчас в Keitaro">было ' + o.published_share + "%</span>" : "") +
          "</td>" +
          '<td class="pin">' +
            (live
              ? '<button class="icon ' + (o.pinned ? "pinned" : "") + '" data-act="' + (o.pinned ? "unpin" : "pin") + '" title="' +
                (o.pinned ? "Открепить вес" : "Закрепить вес (потом можно поменять число)") + '">📌</button>'
              : "") +
          "</td>" +
          '<td class="act">' +
            (live
              ? '<button class="btn small danger" data-act="remove">Remove</button>'
              : '<button class="btn small" data-act="restore">Bring back</button>') +
          "</td>" +
        "</tr>"
      );
    }).join("");

    var bad = s.total_share !== 100;
    return (
      '<div class="' + cls + '" data-stream="' + s.id + '">' + head +
        '<table class="offers"><tbody>' + rows + "</tbody></table>" +
        '<div class="stream-foot">' +
          '<span class="add-wrap"><input class="add-offer" placeholder="Добавить оффер: ID или название"><button class="btn small" data-act="add">Add</button></span>' +
          '<span class="total ' + (bad ? "bad" : "") + '">Σ ' + s.total_share + "%</span>" +
          '<button class="btn small ghost" data-act="cancel"' + (s.is_dirty ? "" : " disabled") + ">Cancel</button>" +
          '<button class="btn small primary" data-act="push"' + (s.is_dirty && !bad ? "" : " disabled") + ">Push to Keitaro</button>" +
        "</div>" +
      "</div>"
    );
  }

  // Делегированные обработчики кнопок редактора
  $("#campaign").on("click", "[data-act]", function () {
    var act = $(this).data("act");
    var $stream = $(this).closest("[data-stream]");
    var streamId = $stream.data("stream");
    var linkId = $(this).closest("[data-link]").data("link");
    var req;

    switch (act) {
      case "add": {
        var $inp = $stream.find(".add-offer");
        var offerId = $inp.data("offerId");
        var typed = $.trim($inp.val());
        if (!offerId && /^\d+$/.test(typed)) offerId = Number(typed);
        if (!offerId) { toast("Выберите оффер из списка", "error"); return; }
        req = api("POST", "/api/streams/" + streamId + "/offers", { offer_id: offerId });
        break;
      }
      case "remove": req = api("POST", "/api/stream-offers/" + linkId + "/remove"); break;
      case "restore": req = api("POST", "/api/stream-offers/" + linkId + "/restore"); break;
      case "pin": {
        var share = Number($(this).closest("tr").find(".share-input").val());
        req = api("POST", "/api/stream-offers/" + linkId + "/pin", { share: share });
        break;
      }
      case "unpin": req = api("POST", "/api/stream-offers/" + linkId + "/unpin"); break;
      case "cancel": req = api("POST", "/api/streams/" + streamId + "/cancel"); break;
      case "push":
        $(this).prop("disabled", true).text("Публикую…");
        req = api("POST", "/api/streams/" + streamId + "/push").done(function () { toast("Опубликовано в Keitaro"); });
        break;
      default: return;
    }
    req.done(render).fail(function () { if (current) render(current); });
  });

  // Изменение закреплённого веса: Enter или уход с поля
  $("#campaign").on("change", ".share-input:not([readonly])", function () {
    var linkId = $(this).closest("[data-link]").data("link");
    var share = Number($(this).val());
    api("POST", "/api/stream-offers/" + linkId + "/pin", { share: share })
      .done(render)
      .fail(function () { if (current) render(current); });
  });
  $("#campaign").on("keydown", ".add-offer", function (e) {
    if (e.key === "Enter" && !$(this).autocomplete("widget").is(":visible")) {
      $(this).closest(".stream-foot").find('[data-act="add"]').trigger("click");
    }
  });

  // ---------- init ----------
  loadRefs();
})();
