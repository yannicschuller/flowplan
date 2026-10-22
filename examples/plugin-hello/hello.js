// The example block extension: a counter and a poll. It talks to Flowplan
// only through postMessage (protocol "flowplan-plugin/1"): Flowplan sends
// "init" with a nonce, every message back repeats it.
(function () {
  "use strict";
  var PROTOCOL = "flowplan-plugin/1";
  var nonce = null;
  var blockType = "counter";
  var readOnly = true;
  var settings = {};
  var data = null;
  var seq = 0;
  var pending = {};
  var app = document.getElementById("app");

  function send(message) {
    message.protocol = PROTOCOL;
    message.nonce = nonce;
    window.parent.postMessage(message, "*");
  }
  function request(type, extra) {
    return new Promise(function (resolve, reject) {
      var id = "r" + ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      var message = extra || {};
      message.type = type;
      message.id = id;
      send(message);
    });
  }
  function resize() {
    send({ type: "resize", height: Math.ceil(document.documentElement.scrollHeight) });
  }
  function save(next, text) {
    data = next;
    render();
    // Viewers and published pages are read-only: the request is refused.
    request("setData", { data: next, text: text }).catch(function () {});
  }
  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderCounter() {
    var count = data && typeof data.count === "number" ? data.count : 0;
    var step = typeof settings.step === "number" && settings.step > 0 ? settings.step : 1;
    var row = el("div", undefined, "row");
    row.appendChild(el("span", String(count), "count"));
    var plus = el("button", "+" + step);
    plus.disabled = readOnly;
    plus.onclick = function () {
      save({ count: count + step }, "Counter: " + (count + step));
    };
    var reset = el("button", "Reset");
    reset.disabled = readOnly;
    reset.onclick = function () {
      save({ count: 0 }, "Counter: 0");
    };
    row.appendChild(plus);
    row.appendChild(reset);
    app.replaceChildren(row);
  }

  function pollText(poll) {
    return poll.question + ": " + poll.options.map(function (o) { return o.label + " (" + o.votes + ")"; }).join(", ");
  }
  function renderPoll() {
    var poll = data && data.question ? data : { question: "", options: [] };
    app.replaceChildren();
    if (!poll.question) {
      if (readOnly) {
        app.appendChild(el("p", "No question yet.", "muted"));
        return;
      }
      var question = el("input");
      question.placeholder = "Question";
      var answers = el("input");
      answers.placeholder = "Answers, separated by commas";
      var create = el("button", "Create poll");
      create.onclick = function () {
        var options = answers.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 10);
        if (!question.value.trim() || options.length < 2) return;
        var next = { question: question.value.trim().slice(0, 200), options: options.map(function (label) { return { label: label.slice(0, 80), votes: 0 }; }) };
        save(next, pollText(next));
      };
      [question, answers, create].forEach(function (node) {
        var row = el("div", undefined, "row");
        row.appendChild(node);
        app.appendChild(row);
      });
      return;
    }
    app.appendChild(el("h1", poll.question));
    var total = poll.options.reduce(function (sum, o) { return sum + o.votes; }, 0) || 1;
    poll.options.forEach(function (option, index) {
      var row = el("div", undefined, "row");
      var vote = el("button", option.label);
      vote.disabled = readOnly;
      vote.onclick = function () {
        var next = JSON.parse(JSON.stringify(poll));
        next.options[index].votes += 1;
        save(next, pollText(next));
      };
      var bar = el("div", undefined, "bar");
      var fill = el("span");
      fill.style.width = Math.round((option.votes / total) * 100) + "%";
      bar.appendChild(fill);
      row.appendChild(vote);
      row.appendChild(bar);
      row.appendChild(el("span", String(option.votes), "muted"));
      app.appendChild(row);
    });
  }

  function render() {
    if (blockType === "poll") renderPoll();
    else renderCounter();
    resize();
  }

  window.addEventListener("message", function (event) {
    // Only the page around the frame speaks to it.
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.protocol !== PROTOCOL) return;
    if (message.type === "init") {
      if (nonce) return;
      nonce = message.nonce;
      blockType = message.blockType;
      readOnly = !!message.readOnly;
      settings = message.settings || {};
      send({ type: "ready" });
      request("getContext").then(function (context) {
        if (context.theme === "dark") document.body.classList.add("dark");
      }).catch(function () {});
      return;
    }
    if (message.nonce !== nonce) return;
    if (message.type === "data") {
      data = message.data;
      render();
    } else if (message.type === "response" && pending[message.id]) {
      var waiting = pending[message.id];
      delete pending[message.id];
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(message.error));
    }
  });
  window.addEventListener("resize", resize);
})();
