# Forms

A form view collects answers directly as records in the database – from members or, if enabled, from anyone with the link.

## Design a form

1. Create a view of the type **Form** in the database.
2. **Design form** opens the editor:
   - title, description and the label of the submit button,
   - questions: order, hide, **required**, help text per question,
   - question type: short or **long text**, **radio buttons** instead of a list, a **linear scale 1–10** for numbers,
   - **confirmation text** after submitting.
3. **Save form**.

Flowplan checks required fields and input types in the browser and on the server. Files properties allow uploads in the form.

## Share a form

Under **Share form**, switch the form on and copy the link.

- **Members only**: answering requires signing in; the answer carries the person's name.
- **Anonymous**: anyone with the link can answer, without an account and without a name.

Person and relation questions only exist in forms for members, because they would reveal members and records.

> [!NOTE]
> Copied or imported forms start switched off and for members only. In the demo, forms can be designed but not made public.

## Answers

Every answer is a normal record: it appears in all views and can be filtered, assigned and commented on.
