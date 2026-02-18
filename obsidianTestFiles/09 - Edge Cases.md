# Edge Cases

Wikilink next to punctuation:
See [[01 - Links]], and [[02 - Formatting]].

Wikilink with heading fragment (we should ignore fragment):
[[02 - Formatting#Formatting]]

Embed with alias:
![[Linux_File_System.png|Alias text that should be ignored for filename]]

Brackets that shouldn’t crash markdown-it:
Text with [[ not closed.
Text with nested [brackets] inside paragraph.

Backlink:
[[00 - Index]]
