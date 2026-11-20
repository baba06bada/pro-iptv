/* ==========================================================================
   js/spatnav.js - LG webOS 2.2.3 Spatial Navigation & Magic Remote Sync
   Pure ES5 - Geometric Focus Calculation + Modal Focus Trap
   ========================================================================== */

var SpatNav = (function () {
  'use strict';

  var currentEl = null;
  var trapStack = [];
  var focusChangeCb = null;
  var boundaryCb = null;
  var mouseBound = false;

  function hasClass(el, cls) {
    if (!el || !el.className) { return false; }
    return (' ' + el.className + ' ').indexOf(' ' + cls + ' ') !== -1;
  }

  function addClass(el, cls) {
    if (!el || hasClass(el, cls)) { return; }
    el.className = el.className ? (el.className + ' ' + cls) : cls;
  }

  function removeClass(el, cls) {
    if (!el || !el.className) { return; }
    var str = (' ' + el.className + ' ').replace(' ' + cls + ' ', ' ');
    el.className = str.replace(/^\s+|\s+$/g, '');
  }

  function isElementVisible(el) {
    if (!el || el.nodeType !== 1) { return false; }
    if (el.disabled) { return false; }
    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) { return false; }
    var node = el;
    while (node && node.nodeType === 1) {
      if (hasClass(node, 'is-hidden')) {
        return false;
      }
      var style = window.getComputedStyle ? window.getComputedStyle(node, null) : node.style;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) {
        return false;
      }
      node = node.parentNode;
    }
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) { return false; }
    if (rect.right < 0 || rect.bottom < 0 || rect.left > 1920 || rect.top > 1080) {
      return false;
    }
    return true;
  }

  function getActiveScope() {
    if (trapStack.length > 0) {
      return trapStack[trapStack.length - 1].container;
    }
    return document.getElementById('app-root') || document.body;
  }

  function getFocusableElements(scope) {
    var root = scope || getActiveScope();
    if (!root) { return []; }
    var nodes = root.querySelectorAll('[data-focusable="true"]');
    var result = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isElementVisible(nodes[i])) {
        result.push(nodes[i]);
      }
    }
    return result;
  }

  function getRect(el) {
    var r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2
    };
  }

  function findNearest(fromEl, direction) {
    var candidates = getFocusableElements();
    if (candidates.length === 0) { return null; }
    if (!fromEl || !isElementVisible(fromEl)) {
      return candidates[0];
    }

    var src = getRect(fromEl);
    var best = null;
    var bestScore = 1e12;
    var i, cand, dst, dx, dy, primary, secondary, overlap, score;

    for (i = 0; i < candidates.length; i++) {
      cand = candidates[i];
      if (cand === fromEl) { continue; }
      dst = getRect(cand);

      dx = dst.cx - src.cx;
      dy = dst.cy - src.cy;

      if (direction === 'left') {
        if (dst.right > src.left + 8 && dst.cx >= src.cx - 4) { continue; }
        primary = src.left - dst.right;
        if (primary < 0) { primary = Math.abs(src.cx - dst.cx); }
        secondary = Math.abs(dy);
        overlap = Math.max(0, Math.min(src.bottom, dst.bottom) - Math.max(src.top, dst.top));
      } else if (direction === 'right') {
        if (dst.left < src.right - 8 && dst.cx <= src.cx + 4) { continue; }
        primary = dst.left - src.right;
        if (primary < 0) { primary = Math.abs(dst.cx - src.cx); }
        secondary = Math.abs(dy);
        overlap = Math.max(0, Math.min(src.bottom, dst.bottom) - Math.max(src.top, dst.top));
      } else if (direction === 'up') {
        if (dst.bottom > src.top + 8 && dst.cy >= src.cy - 4) { continue; }
        primary = src.top - dst.bottom;
        if (primary < 0) { primary = Math.abs(src.cy - dst.cy); }
        secondary = Math.abs(dx);
        overlap = Math.max(0, Math.min(src.right, dst.right) - Math.max(src.left, dst.left));
      } else if (direction === 'down') {
        if (dst.top < src.bottom - 8 && dst.cy <= src.cy + 4) { continue; }
        primary = dst.top - src.bottom;
        if (primary < 0) { primary = Math.abs(dst.cy - src.cy); }
        secondary = Math.abs(dx);
        overlap = Math.max(0, Math.min(src.right, dst.right) - Math.max(src.left, dst.left));
      } else {
        continue;
      }

      // Strongly prefer candidates aligned along the navigation axis
      if (overlap > 4) {
        score = primary * 1.0 + secondary * 0.35;
      } else {
        score = primary * 1.4 + secondary * 3.2 + 120;
      }

      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }

    return best;
  }

  function focusElement(el, silent, source) {
    if (!el || !isElementVisible(el)) { return false; }

    // Enforce active modal focus trap
    if (trapStack.length > 0) {
      var trapRoot = trapStack[trapStack.length - 1].container;
      if (trapRoot && !trapRoot.contains(el)) {
        return false;
      }
    }

    if (currentEl && currentEl !== el) {
      removeClass(currentEl, 'is-focused');
      if (currentEl.tagName === 'INPUT' && document.activeElement === currentEl) {
        try { currentEl.blur(); } catch (e) {}
      }
    }

    currentEl = el;
    addClass(currentEl, 'is-focused');

    if (focusChangeCb && !silent) {
      focusChangeCb(currentEl, source || 'key');
    }
    return true;
  }

  function findFocusableAncestor(target) {
    var node = target;
    while (node && node !== document.body && node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('data-focusable') === 'true') {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function bindMagicRemoteMouse() {
    if (mouseBound) { return; }
    mouseBound = true;
    document.addEventListener('mouseover', function (e) {
      var target = e.target || e.srcElement;
      var focusable = findFocusableAncestor(target);
      if (focusable && focusable !== currentEl && isElementVisible(focusable)) {
        focusElement(focusable, false, 'mouse');
      }
    }, false);
  }

  return {
    init: function (options) {
      if (options) {
        if (typeof options.onFocusChange === 'function') {
          focusChangeCb = options.onFocusChange;
        }
        if (typeof options.onBoundary === 'function') {
          boundaryCb = options.onBoundary;
        }
      }
      bindMagicRemoteMouse();
    },

    getCurrent: function () {
      if (currentEl && !isElementVisible(currentEl)) {
        return null;
      }
      return currentEl;
    },

    focus: function (el, silent) {
      if (typeof el === 'string') {
        el = document.getElementById(el);
      }
      return focusElement(el, !!silent);
    },

    focusFirstIn: function (container) {
      if (typeof container === 'string') {
        container = document.getElementById(container);
      }
      var list = getFocusableElements(container);
      if (list.length > 0) {
        return focusElement(list[0], false);
      }
      return false;
    },

    move: function (direction) {
      if (!currentEl || !isElementVisible(currentEl)) {
        var list = getFocusableElements();
        if (list.length > 0) {
          focusElement(list[0], false);
          return true;
        }
        return false;
      }

      // Give virtualized lists first chance to intercept boundary movement
      if (boundaryCb) {
        var handled = boundaryCb(direction, currentEl);
        if (handled === true) {
          return true;
        }
      }

      var next = findNearest(currentEl, direction);
      if (next) {
        focusElement(next, false);
        return true;
      }
      return false;
    },

    pushTrap: function (container, initialFocusEl) {
      if (typeof container === 'string') {
        container = document.getElementById(container);
      }
      if (!container) { return; }
      trapStack.push({
        container: container,
        returnTo: currentEl
      });
      if (initialFocusEl) {
        focusElement(initialFocusEl, false);
      } else {
        this.focusFirstIn(container);
      }
    },

    popTrap: function () {
      if (trapStack.length === 0) { return; }
      var popped = trapStack.pop();
      if (popped && popped.returnTo && isElementVisible(popped.returnTo)) {
        focusElement(popped.returnTo, false);
      } else {
        this.focusFirstIn(getActiveScope());
      }
    },

    clearTraps: function () {
      trapStack = [];
    },

    hasTrap: function () {
      return trapStack.length > 0;
    },

    isVisible: isElementVisible
  };
})();
