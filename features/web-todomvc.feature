@web
Feature: TodoMVC (public demo app, web only)

  Background:
    Given [web] open https://demo.playwright.dev/todomvc

  @smoke
  Scenario: Add and complete a todo
    When [web] add a todo "Buy milk" and press Enter
    And [web] tick the checkbox of the todo "Buy milk"
    Then [web] the todo "Buy milk" is shown as completed
    And [web] the counter shows 0 items left

  Scenario: Add several todos and filter active ones
    When [web] add the todos "Write tests", "Review PR" and "Deploy", each followed by Enter
    And [web] complete the todo "Review PR"
    And [web] click the "Active" filter
    Then [web] the list shows "Write tests" and "Deploy" but not "Review PR"

  Scenario: Delete a todo
    When [web] add a todo "Temporary" and press Enter
    And [web] hover the todo "Temporary" and click its delete (x) button
    Then [web] the todo list is empty
