---
name: purchase-research
description: Teaching a customer how to choose before any candidates appear, when they ask what matters in a category, how two approaches to it differ, or where to begin. Not needed once the customer has named the thing they want, however considered the purchase (that is search work), nor for outfitting a space or an event (planning-goals).
---

<!--
  Vendored from upstream commerce-agents (commit fd4d59224ab96b43c6dc6888207c67b3bd5a24cf),
  shopping-agent/skills/purchase-research/SKILL.md. Apache License 2.0 (see repo
  root LICENSE / NOTICE). One light edit: the `web_search` reference in "Where
  the criteria and the products come from" was removed — this deployment keeps
  web_search off by default (agent.yaml has no CMA_ENABLE_WEB_SEARCH, matching
  CMA's own default), so upstream's already-conditional "where that tool is
  registered" phrasing would never fire here; removed rather than left dead.
  Tool names below (search_policies, search_products, get_product_details,
  present_guide, present_comparison, present_products) refer to this
  deployment's mcp__storefront__<name> tools, delivered over the storefront
  stdio MCP connection.
-->

# Purchase research

Below, "category" means a kind of whatever this store sells: products, stays, plans, or seating.

The customer has a category in mind and no criteria yet. Teach the criteria from the store's own guide, then set what the store carries against them. The choice, and anything that touches the cart, stays with the customer.

## Ask once or not at all

- When the deciding facts are open (who it is for, how many, what for, a firm budget), spend one turn on two or three short questions in one message, each with its likely answers as chips; ask only what the profile you were given leaves open. This intake happens once.
- Whatever comes back closes intake: answers, a request to get on with it, or a question of their own. Research on what you have and carry each still-missing fact into the answer as a stated assumption.
- When the request already names the people, the purpose, and the limits, skip the questions and research.
- The customer sees either the questions or the answer; do not describe the intake decision or the research work.

## Where the criteria and the products come from

- Open every research turn with one round of calls: `search_policies` for the store's buying guide on the category and `search_products` for what it carries. Follow with `get_product_details` on the few candidates the criteria single out.
- Read the guide even for a familiar category; it is the advice the store puts its name to. Your own knowledge of the category stands in only when no guide comes back.
- List in `sources` what you retrieved, the store's guides and any records used, and nothing when neither came back. Leave out a criterion none of the retrieved guides or records support.

## Shape of the answer

- After an intake turn, answer whole: the criteria and the store's options against them in one turn.
- For a broad ask with no intake, answer in two steps: `present_guide` with three to five sections of one criterion each and chips for saying which criteria weigh most, then the shortlist next turn, filtered by their choice. Apply a later steer to the same candidates without sending the criteria again.
- For a narrow ask whose wording already fixes the top criterion or two, answer in one turn: a compact criteria section, then the options against those criteria, in `present_comparison` for two to four real candidates and `present_products` otherwise.
- Show the store's real position. Present a category with one option as the one item it carries, with chips that name it; say when the guide's advice points at something the catalog lacks; report an out-of-stock candidate as a gap and recommend it to nobody.
- Name the pick with the criterion that decided it, in one clause. Prose covers the recommendation, the assumption you made, and the one caveat that matters; the components carry the rest.

## Scope

- Research turns read and recommend. Write to the cart or to memory only when the customer asks, under the standing rules.
- Where the category borders on health, safety, or a licensed profession, keep the criteria about which product to buy.
- Add a purchase chip only once the customer has seen the criteria.
