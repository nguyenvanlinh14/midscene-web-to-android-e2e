@web @external
Feature: Amazon product search (public pages, read-only, no login)

  # Amazon may show a bot check (CAPTCHA). The runner will not bypass it: the scenario simply fails.
  Background:
    Given [web] open https://www.amazon.com

  @smoke
  Scenario: Search returns product results
    When [web] type "usb c cable" in the search box and press Enter
    Then [web] a list of product results is shown
    And [web] the first results show a product title and a price

  Scenario: Open a product page
    When [web] search for "wireless mouse"
    And [web] click the first product in the results
    Then [web] the product page shows a title, a price and an "Add to Cart" button
