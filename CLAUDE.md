js400 is a one-to-one version of IBM's JTOpen project

Use the JTOpen (in ` ./JTOpen/**`) project as reference and migrate its Java code to js400, with special attention to the binary protocol being used to speak to the iSeries (AS400).

When issues arise in js400, make sure to find the corresponding code in JTOpen and understand how it works, then replicate the same logic in js400.

Java JTopen type system should be replicated in Typescript.

Since JDBC is not available, make sure JDBC-like calls are made available to DB2 access (queries, updates, etc).

Try not to depend on npm modules. If needed, use very, very popular npm modules, otherwise avoid it.
