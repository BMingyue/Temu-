/* Make Enter trigger the nearest native Temu query/search button. */
(() => {
  "use strict";

  const helpers = {
    actionLabels:new Set(["查询", "搜索"]),
    extensionRootSelector:"#temuCollectorRoot,#temuKeywordAccelerator,#temu-flow-image-viewer,#temu-embedded-retail-price,#temuQuickNavHost",
    normalizeText(value) {
      return String(value || "").replace(/\s+/g, "").trim();
    },
    isEligibleInput(target) {
      if (!target?.matches?.("input")) return false;
      const type = String(target.type || "text").toLowerCase();
      if (["button", "submit", "reset", "checkbox", "radio", "file", "range", "color", "hidden", "password"].includes(type)) return false;
      if (target.disabled || target.readOnly) return false;
      if (target.closest?.(helpers.extensionRootSelector)) return false;
      if (target.closest?.("tbody,[role='gridcell'],[role='cell'],[class*='table-row'],[class*='Table-row']")) return false;
      if (target.getAttribute?.("aria-expanded") === "true") return false;
      if (target.closest?.("[class*='select-open'],[class*='Select-open'],[class*='picker-focused'],[class*='Picker-focused']")) return false;
      return true;
    },
    actionDisabled(action) {
      return !action
        || action.disabled === true
        || action.getAttribute?.("disabled") !== null
        || action.getAttribute?.("aria-disabled") === "true"
        || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/i.test(String(action.className || ""));
    },
    isVisible(action) {
      if (!action?.getClientRects?.().length || action.hidden) return false;
      const style = action.ownerDocument?.defaultView?.getComputedStyle?.(action);
      return !style || (style.visibility !== "hidden" && style.display !== "none");
    },
    queryActions(root) {
      return [...(root?.querySelectorAll?.("button,[role='button'],a,input[type='submit'],input[type='button']") || [])]
        .filter((action) => !action.closest?.(helpers.extensionRootSelector))
        .filter((action) => {
          const text = action.matches?.("input") ? action.value : action.innerText || action.textContent;
          return helpers.actionLabels.has(helpers.normalizeText(text))
            && !helpers.actionDisabled(action)
            && helpers.isVisible(action);
        });
    },
    visualDistance(input, action) {
      const left = input?.getBoundingClientRect?.() || {};
      const right = action?.getBoundingClientRect?.() || {};
      const leftX = Number(left.left || 0) + Number(left.width || 0) / 2;
      const leftY = Number(left.top || 0) + Number(left.height || 0) / 2;
      const rightX = Number(right.left || 0) + Number(right.width || 0) / 2;
      const rightY = Number(right.top || 0) + Number(right.height || 0) / 2;
      return Math.abs(leftX - rightX) + Math.abs(leftY - rightY) * 3;
    },
    nearestAction(input, actions) {
      return [...actions].sort((left, right) => helpers.visualDistance(input, left) - helpers.visualDistance(input, right))[0] || null;
    },
    isNearby(input, action) {
      const left = input?.getBoundingClientRect?.() || {};
      const right = action?.getBoundingClientRect?.() || {};
      const verticalGap = Math.max(0, Number(right.top || 0) - Number(left.bottom || 0), Number(left.top || 0) - Number(right.bottom || 0));
      const horizontalGap = Math.max(0, Number(right.left || 0) - Number(left.right || 0), Number(left.left || 0) - Number(right.right || 0));
      return verticalGap <= 240 && horizontalGap <= 1800;
    },
    findQueryAction(input, doc = input?.ownerDocument) {
      if (!helpers.isEligibleInput(input) || !doc) return null;
      const form = input.closest?.("form");
      if (form) {
        const formActions = helpers.queryActions(form);
        if (formActions.length) {
          const nearest = helpers.nearestAction(input, formActions);
          return helpers.isNearby(input, nearest) ? nearest : null;
        }
      }
      let scope = input.parentElement;
      while (scope && scope !== doc.body && scope !== doc.documentElement) {
        const actions = helpers.queryActions(scope);
        if (actions.length) {
          const nearest = helpers.nearestAction(input, actions);
          return helpers.isNearby(input, nearest) ? nearest : null;
        }
        scope = scope.parentElement;
      }
      const pageActions = helpers.queryActions(doc);
      if (pageActions.length !== 1) return null;
      const nearest = pageActions[0];
      return helpers.isNearby(input, nearest) ? nearest : null;
    },
    shouldHandle(event) {
      return event?.key === "Enter"
        && !event.defaultPrevented
        && !event.repeat
        && !event.isComposing
        && Number(event.keyCode || 0) !== 229
        && !event.shiftKey
        && !event.ctrlKey
        && !event.altKey
        && !event.metaKey;
    },
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
    return;
  }
  if (window.__temuEnterQueryInstalled) return;
  window.__temuEnterQueryInstalled = true;

  document.addEventListener("keydown", (event) => {
    if (!helpers.shouldHandle(event)) return;
    const action = helpers.findQueryAction(event.target, document);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    action.click();
  }, true);
})();
