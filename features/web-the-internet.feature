@web
Feature: The Internet (public practice site for UI automation)

  Scenario: Checkboxes can be toggled
    Given [web] open https://the-internet.herokuapp.com/checkboxes
    When [web] tick the first checkbox and untick the second checkbox
    Then [web] the first checkbox is checked and the second checkbox is unchecked

  Scenario: Dropdown option can be selected
    Given [web] open https://the-internet.herokuapp.com/dropdown
    When [web] choose "Option 2" from the dropdown
    Then [web] the dropdown shows "Option 2" as selected

  Scenario: Dynamic content loads after clicking Start
    Given [web] open https://the-internet.herokuapp.com/dynamic_loading/1
    When [web] click the Start button
    Then [web] the text "Hello World!" appears on the page
