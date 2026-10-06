Feature: Send a notification from the web console to an Android device

  Background:
    Given [web] open {consoleUrl}
    And [android] the device is on the Home screen with no old notifications
    When [android] open the receiver page {receiverUrl} in Chrome
    And [android] wait until the "Push Receiver" page is shown
    And [android] tap Subscribe and allow notifications if asked
    And [android] wait until the page shows "Subscribed" and a 6-digit pairing code
    And [web] enter the pairing code shown on the phone

  @smoke @push
  Scenario: Basic notification is delivered
    When [web] enter title "Hello QA" and body "Test message 01"
    And [web] click Send
    Then [web] the page shows that the notification was sent successfully
    And [android] the notification shade shows "Hello QA" and "Test message 01"

  @push
  Scenario: Notification without a body is delivered
    When [web] enter title "Title only" and leave the body empty
    And [web] click Send
    Then [web] the page shows that the notification was sent successfully
    And [android] the notification shade shows "Title only"

  @push
  Scenario: Special characters and emoji are delivered intact
    When [web] enter title "Sale 50% <b>& more</b>" and body "Xin chào 👋 — café"
    And [web] click Send
    Then [web] the page shows that the notification was sent successfully
    And [android] the notification shade shows "Sale 50%" and "Xin chào"

  @push
  Scenario: Long body is delivered
    When [web] enter title "Long message" and body "The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog."
    And [web] click Send
    Then [web] the page shows that the notification was sent successfully
    And [android] the notification shade shows "Long message"

  @push
  Scenario Outline: Several notifications in a row
    When [web] enter title "<title>" and body "<body>"
    And [web] click Send
    Then [android] the notification shade shows "<title>" and "<body>"

    Examples:
      | title   | body        |
      | First   | Message one |
      | Second  | Message two |

  @validation
  Scenario: Missing title is rejected
    When [web] leave the title empty and enter body "No title here"
    And [web] click Send
    Then [web] the page shows an error saying the title is required

  @validation
  Scenario: Unknown pairing code is rejected
    When [web] replace the pairing code with 000000, enter title "Hi" and click Send
    Then [web] the page shows an error saying the pairing code is unknown or expired
