-- 012-promote-super-admin.sql — role 2단계(admin/user)→3단계(super_admin/admin/user) 확장의
-- 데이터 이관분. 컬럼 자체는 TEXT라 DDL 불요(schema.sql 컬럼 주석만 갱신), 기존 두 계정 중
-- 최초 유일 admin(hopegiver@malgnsoft.com)만 super_admin으로 승격한다.
-- chhwi@malgnsoft.com은 문자열 그대로 'admin'(신 체계에서 admin=권한상 user와 동일이 되므로
-- 별도 UPDATE 불요).
UPDATE users SET role = 'super_admin' WHERE username = 'hopegiver@malgnsoft.com';
